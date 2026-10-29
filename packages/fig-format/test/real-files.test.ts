// Runs against every real file dropped into fixtures/ (git-ignored, so this
// suite is empty on a fresh clone). These are the step-7 compatibility checks
// in their first form.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { decodeFig, encodeFig } from "../src";

const dir = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const files = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".fig") && f !== "synthetic.fig");

// vitest fails a file with no tests at all, so a fresh clone gets one skipped placeholder.
if (files.length === 0) it.skip("no real .fig files in fixtures/", () => {});

describe.each(files)("%s", (name) => {
  const fig = decodeFig(new Uint8Array(readFileSync(dir + name)));
  const nodes = fig.message.nodeChanges as any[];
  const blobs = fig.message.blobs as { bytes: Uint8Array }[];

  it("decode → encode → decode is structurally identical", () => {
    const back = decodeFig(encodeFig(fig));
    expect(back.schema).toEqual(fig.schema);
    expect(back.message).toEqual(fig.message);
    // isDeepStrictEqual compares typed arrays natively; toEqual walks multi-MB images byte by byte.
    expect(isDeepStrictEqual(back.zip, fig.zip)).toBe(true);
  });

  it("every parent reference resolves and exactly one DOCUMENT root exists", () => {
    const ids = new Set(nodes.map((n) => `${n.guid.sessionID}:${n.guid.localID}`));
    expect(nodes.filter((n) => !n.parentIndex).map((n) => n.type)).toEqual(["DOCUMENT"]);
    for (const n of nodes) {
      if (n.parentIndex) expect(ids).toContain(`${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`);
    }
  });

  it("image entries are keyed by SHA-1 and paints reference them", () => {
    for (const [hash, bytes] of fig.zip?.images ?? []) {
      expect(createHash("sha1").update(bytes).digest("hex")).toBe(hash);
    }
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    for (const n of nodes) {
      for (const p of n.fillPaints ?? []) {
        if (p.type === "IMAGE") expect(fig.zip?.images.has(hex(p.image.hash))).toBe(true);
      }
    }
  });

  it("geometry blobs decode as [cmd][float32...] path commands", () => {
    const argc: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
    for (const n of nodes) {
      for (const g of [...(n.fillGeometry ?? []), ...(n.strokeGeometry ?? [])]) {
        const b = blobs[g.commandsBlob]!.bytes;
        let o = 0;
        while (o < b.length) {
          const count = argc[b[o]!];
          expect(count, `cmd byte ${b[o]} at ${o} in blob ${g.commandsBlob}`).toBeDefined();
          o += 1 + count! * 4;
        }
        expect(o).toBe(b.length);
      }
    }
  });

  it("vector network blobs match the [counts][vertices][segments] layout", () => {
    // header u32×3 (vertices, segments, regions) · vertex = styleID u32, x f32, y f32 (12B)
    // · segment = styleID u32, start u32, tanStart f32×2, end u32, tanEnd f32×2 (28B)
    for (const n of nodes) {
      if (!n.vectorData) continue;
      const b = blobs[n.vectorData.vectorNetworkBlob]!.bytes;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const [vertices, segments, regions] = [0, 4, 8].map((o) => dv.getUint32(o, true));
      if (regions !== 0) continue; // region layout not yet decoded
      expect(b.length, n.name).toBe(12 + vertices! * 12 + segments! * 28);
      for (let s = 0; s < segments!; s++) {
        const o = 12 + vertices! * 12 + s * 28;
        expect(dv.getUint32(o + 4, true)).toBeLessThan(vertices!);
        expect(dv.getUint32(o + 16, true)).toBeLessThan(vertices!);
      }
    }
  });
});
