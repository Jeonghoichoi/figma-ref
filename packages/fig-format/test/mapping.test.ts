import * as ref from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { decodeBinarySchema } from "@figref/kiwi";
import { createDocument, createNode, getChildren, insertNode, moveNode, removeNode, type Document, type Paint, type PathCommand } from "@figref/model";
import { FIG_LIKE_SCHEMA_TEXT, sampleMessage } from "../../kiwi/test/sample-message";
import { decodeFig, decodePathBlob, documentToFig, encodeFig, encodePathBlob, figToDocument, type FigFile } from "../src";

const schema = decodeBinarySchema(ref.encodeBinarySchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT)));

/** The synthetic file after one encode/decode, so floats are already float32. */
function loadSynthetic(): FigFile {
  return decodeFig(encodeFig({
    magic: "fig-kiwi", version: 48, schema, message: sampleMessage(),
    compression: ["deflate-raw", "deflate-raw"], extraChunks: [],
    zip: { meta: { file_name: "Synthetic" }, images: new Map(), other: new Map() },
  }));
}

/** Save → bytes → open, the way the app will do it. */
function reopen(doc: Document, base?: FigFile): { doc: Document; fig: FigFile } {
  const fig = decodeFig(encodeFig(documentToFig(doc, base)));
  return { doc: figToDocument(fig), fig };
}

const changes = (fig: FigFile) => fig.message.nodeChanges as Record<string, any>[];
const byId = (fig: FigFile, id: string) => changes(fig).find((c) => `${c.guid.sessionID}:${c.guid.localID}` === id);

describe("path blobs", () => {
  it("round-trip every command type", () => {
    const cmds: PathCommand[] = [
      { op: "M", x: 0, y: 0 }, { op: "L", x: 10, y: 0 }, { op: "Q", x1: 15, y1: 5, x: 10, y: 10 },
      { op: "C", x1: 5, y1: 15, x2: 0, y2: 15, x: 0, y: 10 }, { op: "Z" },
    ];
    const bytes = encodePathBlob(cmds);
    expect(bytes.length).toBe(1 + 8 + 1 + 8 + 1 + 16 + 1 + 24 + 1);
    expect(decodePathBlob(bytes)).toEqual(cmds);
  });

  it("rejects unknown commands", () => {
    expect(() => decodePathBlob(new Uint8Array([9]))).toThrow(/unknown command 9/);
  });
});

describe("mapping (synthetic schema)", () => {
  it("decodes nodes into the model", () => {
    const doc = figToDocument(loadSynthetic());
    expect(doc.rootId).toBe("0:0");
    expect(getChildren(doc, "0:2").map((n) => n.name)).toEqual(["Rect", "Label"]);
    const frame = doc.nodes.get("0:2")!;
    expect(frame.type).toBe("FRAME");
    expect(frame.clipsContent).toBe(true);
    expect(frame.fills[0]).toMatchObject({ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } });
    expect(doc.nodes.get("0:4")!.text?.characters).toBe("Hello\nWorld 🌍");
  });

  it("is lossless when nothing is edited", () => {
    const fig = loadSynthetic();
    expect(documentToFig(figToDocument(fig)).message).toEqual(fig.message);
  });

  it("an edit rewrites only the edited node", () => {
    const fig = loadSynthetic();
    const doc = figToDocument(fig);
    const rect = doc.nodes.get("0:3")!;
    const fill = rect.fills[0] as Extract<Paint, { type: "SOLID" }>;
    rect.fills = [{ ...fill, color: { r: 1, g: 0, b: 0, a: 1 } }];

    const back = reopen(doc);
    expect(back.doc.nodes.get("0:3")!.fills[0]).toMatchObject({ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } });
    for (const c of changes(fig)) {
      const id = `${c.guid.sessionID}:${c.guid.localID}`;
      if (id !== "0:3") expect(byId(back.fig, id), id).toEqual(c);
    }
  });

  it("creates nodes with geometry, effects and group semantics", () => {
    const doc = figToDocument(loadSynthetic());
    insertNode(doc, createNode({ id: "5:1", type: "GROUP", name: "Group" }), "0:1");
    insertNode(doc, createNode({
      id: "5:2", type: "RECTANGLE", name: "New",
      size: { x: 40, y: 20 },
      fills: [{ type: "SOLID", color: { r: 0, g: 0.5, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
      effects: [{ type: "DROP_SHADOW", visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, spread: 0, blendMode: "NORMAL" }],
      fillGeometry: [{ windingRule: "NONZERO", commands: [{ op: "M", x: 0, y: 0 }, { op: "L", x: 40, y: 0 }, { op: "L", x: 40, y: 20 }, { op: "Z" }] }],
    }), "5:1");

    const { doc: back, fig } = reopen(doc);
    expect(back.nodes.get("5:1")!.type).toBe("GROUP");
    expect(byId(fig, "5:1")).toMatchObject({ type: "FRAME", resizeToFit: true, phase: "CREATED" });
    const rect = back.nodes.get("5:2")!;
    expect(rect.parentId).toBe("5:1");
    expect(rect.effects[0]).toMatchObject({ type: "DROP_SHADOW", radius: 4, offset: { x: 0, y: 4 } });
    expect(rect.fillGeometry![0]!.commands).toEqual(doc.nodes.get("5:2")!.fillGeometry![0]!.commands);
    // Existing blobs keep their indices; new geometry is appended.
    expect(byId(fig, "5:2")!.fillGeometry[0].commandsBlob).toBe(2);
    expect(changes(fig).slice(-2).map((c) => c.name)).toEqual(["Group", "New"]);
  });

  it("text edits keep paragraphs and style ids consistent", () => {
    const doc = figToDocument(loadSynthetic());
    const text = doc.nodes.get("0:4")!;
    text.raw = { ...text.raw, textData: { ...(text.raw!.textData as object), characterStyleIDs: new Array(13).fill(0) } };
    text.text = { ...text.text!, characters: "one\ntwo\nthree" };

    const { fig } = reopen(doc);
    const td = byId(fig, "0:4")!.textData;
    expect(td.characters).toBe("one\ntwo\nthree");
    expect(td.lines).toHaveLength(3);
    expect(td.characterStyleIDs).toHaveLength(13);
  });

  it("moves and deletes", () => {
    const doc = figToDocument(loadSynthetic());
    moveNode(doc, "0:4", "0:1", 0);
    removeNode(doc, "0:2");
    const { doc: back } = reopen(doc);
    expect(back.nodes.has("0:2")).toBe(false);
    expect(back.nodes.has("0:3")).toBe(false);
    expect(getChildren(back, "0:1").map((n) => n.id)).toEqual(["0:4"]);
  });

  it("new documents need a base file for the schema", () => {
    const doc = createDocument();
    expect(() => documentToFig(doc)).toThrow(/pass a base/);
    const { doc: back } = reopen(doc, loadSynthetic());
    expect([...back.nodes.values()].map((n) => n.type)).toEqual(["DOCUMENT", "CANVAS"]);
  });
});
