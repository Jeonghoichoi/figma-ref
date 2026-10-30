import * as ref from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { decodeBinarySchema } from "@figref/kiwi";
import { FIG_LIKE_SCHEMA_TEXT, sampleMessage } from "../../kiwi/test/sample-message";
import { decodeFig, encodeFig, pruneFig, type FigFile } from "../src";

const schema = decodeBinarySchema(ref.encodeBinarySchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT)));
const path = (n: number) => ({ windingRule: "NONZERO", commandsBlob: n });
const hash = (b: number) => new Uint8Array(20).fill(b);

function fixture(): FigFile {
  const msg = sampleMessage() as any;
  msg.blobs = [0, 1, 2, 3].map((i) => ({ bytes: new Uint8Array([i]) }));
  msg.nodeChanges[2].fillGeometry = [path(3)]; // frame
  msg.nodeChanges[3].fillGeometry = [path(1)]; // rect inside frame
  msg.nodeChanges[3].fillPaints = [{ type: "IMAGE", opacity: 1, visible: true, image: { hash: hash(0xaa) } }];
  msg.nodeChanges[1].fillGeometry = [path(2)]; // page keeps blob 2
  return {
    magic: "fig-kiwi", version: 48, schema, message: msg, compression: ["deflate-raw", "deflate-raw"], extraChunks: [],
    zip: {
      thumbnail: new Uint8Array([1]),
      images: new Map([["aa".repeat(20), new Uint8Array([9])], ["bb".repeat(20), new Uint8Array([8])]]),
      other: new Map(),
    },
  };
}

describe("pruneFig", () => {
  it("removes a subtree, its blobs and images, and renumbers blob references", () => {
    const { fig, removedNodes, removedBlobs, removedImages } = pruneFig(fixture(), ["0:2"]);
    const nodes = fig.message.nodeChanges as any[];
    expect(nodes.map((n) => n.name)).toEqual(["Document", "Page 1"]);
    expect(removedNodes).toBe(3); // frame + rect + text
    expect(removedBlobs).toBe(3); // 0 (unreferenced), 1 (rect), 3 (frame)
    expect((fig.message.blobs as any[]).map((b) => b.bytes[0])).toEqual([2]);
    expect(nodes[1].fillGeometry[0].commandsBlob).toBe(0);
    expect(removedImages.sort()).toEqual(["aa".repeat(20), "bb".repeat(20)]);
    expect(fig.zip!.thumbnail).toBeUndefined();
    // Still a valid file.
    expect(decodeFig(encodeFig(fig)).message.nodeChanges).toHaveLength(2);
  });

  it("does not modify the input and rejects unknown ids", () => {
    const input = fixture();
    pruneFig(input, ["0:3"]);
    expect((input.message.nodeChanges as any[]).length).toBe(5);
    expect(() => pruneFig(input, ["9:9"])).toThrow(/not found/);
  });
});
