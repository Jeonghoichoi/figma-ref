// Mapping checks against the real samples in fixtures/ (git-ignored; skipped on a fresh clone).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Node, Paint } from "@figref/model";
import { decodeFig, documentToFig, encodeFig, figToDocument } from "../src";

const dir = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const files = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f.endsWith(".fig") && f !== "synthetic.fig");

if (files.length === 0) it.skip("no real .fig files in fixtures/", () => {});

describe.each(files)("%s", (name) => {
  const fig = decodeFig(new Uint8Array(readFileSync(dir + name)));
  const doc = figToDocument(fig);
  const nodes = [...doc.nodes.values()];
  const find = (pred: (n: Node) => boolean) => nodes.find(pred);

  it("is lossless when nothing is edited", () => {
    const out = documentToFig(doc);
    expect(out.message.nodeChanges).toEqual(fig.message.nodeChanges);
    expect(out.message.blobs).toEqual(fig.message.blobs);
  });

  // Samples differ in content, so each check runs only when the sample has that kind of node.
  it("decodes the shapes seen in the sample into model values", () => {
    expect(nodes.filter((n) => n.type === "UNKNOWN")).toEqual([]);
    expect(find((n) => n.type === "FRAME")?.clipsContent).toBe(true);
    for (const g of nodes.filter((n) => /^Group \d+$/.test(n.name))) expect(g.type, g.name).toBe("GROUP");

    for (const text of nodes.filter((n) => n.type === "TEXT")) {
      expect(text.text!.style.fontFamily.length).toBeGreaterThan(0);
      expect(text.text!.characters.length).toBeGreaterThan(0);
      expect(text.textLayout?.glyphs.length).toBeGreaterThan(0);
    }

    for (const image of nodes.flatMap((n) => n.fills).filter((p): p is Extract<Paint, { type: "IMAGE" }> => p.type === "IMAGE")) {
      expect(doc.images.has(image.imageHash)).toBe(true);
    }

    const star = find((n) => n.type === "STAR");
    if (star) expect(star.fillGeometry![0]!.commands.filter((c) => c.op === "L")).toHaveLength(10);
  });

  it("an edit rewrites only the edited node", () => {
    const edited = figToDocument(fig);
    const target = [...edited.nodes.values()].find((n) => n.type === "STAR")!;
    target.fills = target.fills.map((p) => (p.type === "SOLID" ? { ...p, color: { r: 1, g: 0.2, b: 0.2, a: 1 } } : p));

    const out = documentToFig(edited);
    const before = fig.message.nodeChanges as any[];
    const after = out.message.nodeChanges as any[];
    expect(after).toHaveLength(before.length);
    const differing = after.filter((c, i) => JSON.stringify(c, replacer) !== JSON.stringify(before[i], replacer));
    expect(differing.map((c) => c.name)).toEqual([target.name]);
    expect(differing[0].fillPaints[0].authoredColor).toBeUndefined();

    // Kept for manual verification in the original app (fixtures/out is git-ignored).
    mkdirSync(dir + "out", { recursive: true });
    writeFileSync(`${dir}out/${name.replace(/\.fig$/, "")}-edited.fig`, encodeFig(out));
  });
});

function replacer(_k: string, v: unknown) {
  if (v instanceof Uint8Array) return Array.from(v);
  if (typeof v === "bigint") return v.toString();
  return v;
}
