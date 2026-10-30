import * as ref from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { decodeFig, documentToFig, encodeFig, figToDocument } from "@figref/fig-format";
import { decodeBinarySchema } from "@figref/kiwi";
import { createDocument, createNode, getChildren, insertNode, primitiveGeometry, type Document } from "@figref/model";
import { FIG_LIKE_SCHEMA_TEXT, sampleMessage } from "../../../../packages/kiwi/test/sample-message";
import { Editor } from "./Editor";

/** Page with a 400×300 frame at (100,100) containing a 50×50 rect at (10,10). */
function setup(): Editor {
  const doc = createDocument();
  const frame = createNode({ id: "1:1", type: "FRAME", name: "Frame", size: { x: 400, y: 300 }, clipsContent: true });
  frame.transform = { ...frame.transform, m02: 100, m12: 100 };
  insertNode(doc, frame, "0:1");
  const rect = createNode({ id: "1:2", type: "ROUNDED_RECTANGLE", name: "Rect", size: { x: 50, y: 50 } });
  rect.transform = { ...rect.transform, m02: 10, m12: 10 };
  rect.fillGeometry = primitiveGeometry(rect);
  insertNode(doc, rect, "1:1");
  return new Editor(doc, "0:1");
}

const pos = (e: Editor, id: string) => {
  const t = e.world(id);
  return [Math.round(t.m02 * 100) / 100, Math.round(t.m12 * 100) / 100];
};

describe("Editor", () => {
  it("click picks the child of a frame; deep pick and enter work", () => {
    const e = setup();
    expect(e.pick(120, 120)).toBe("1:2");
    expect(e.pick(300, 300)).toBe("1:1"); // empty frame area
    expect(e.pick(10, 10)).toBeNull();
  });

  it("creates shapes inside the frame under the pointer", () => {
    const e = setup();
    e.transact(() => e.create("rectangle", { x: 200, y: 200 }, { x: 260, y: 230 }));
    const [id] = e.selection;
    const n = e.node(id!);
    expect(n.parentId).toBe("1:1");
    expect(n.size).toEqual({ x: 60, y: 30 });
    expect(pos(e, id!)).toEqual([200, 200]);
    expect(n.fillGeometry?.[0]?.commands.length).toBeGreaterThan(0);
  });

  it("undo restores parent and position after a reparenting move", () => {
    const e = setup();
    e.transact(() => e.dropInto(["1:2"], 50, 50)); // outside the frame → page
    expect(e.node("1:2").parentId).toBe("0:1");
    expect(pos(e, "1:2")).toEqual([110, 110]); // world position kept
    e.undo();
    expect(e.node("1:2").parentId).toBe("1:1");
    expect(e.node("1:2").transform.m02).toBe(10);
    e.redo();
    expect(e.node("1:2").parentId).toBe("0:1");
  });

  it("group fits its bounds and keeps children in place; ungroup restores", () => {
    const e = setup();
    e.transact(() => e.create("ellipse", { x: 200, y: 200 }, { x: 240, y: 240 }));
    const ellipse = [...e.selection][0]!;
    e.select(["1:2", ellipse]);
    e.group();
    const [g] = e.selection;
    const group = e.node(g!);
    expect(group.type).toBe("GROUP");
    expect(pos(e, g!)).toEqual([110, 110]);
    expect(group.size).toEqual({ x: 130, y: 130 });
    expect(pos(e, "1:2")).toEqual([110, 110]);
    expect(pos(e, ellipse)).toEqual([200, 200]);

    e.ungroup();
    expect(e.doc.nodes.has(g!)).toBe(false);
    expect(e.node("1:2").parentId).toBe("1:1");
    expect(pos(e, ellipse)).toEqual([200, 200]);
  });

  it("deleting a group member re-fits the group; deleting all removes it", () => {
    const e = setup();
    e.transact(() => e.create("rectangle", { x: 300, y: 300 }, { x: 320, y: 320 }));
    const r2 = [...e.selection][0]!;
    e.select(["1:2", r2]);
    e.group();
    const g = [...e.selection][0]!;
    e.select([r2]);
    e.deleteSelection();
    expect(e.node(g).size).toEqual({ x: 50, y: 50 });
    e.select(["1:2"]);
    e.deleteSelection();
    expect(e.doc.nodes.has(g)).toBe(false);
  });

  it("resizing a group scales children from the gesture start (no compounding)", () => {
    const e = setup();
    e.select(["1:2"]);
    e.group();
    const g = [...e.selection][0]!;
    const start = e.beginResize(g);
    for (const x of [60, 80, 100]) e.resizeFromHandle(g, start, "e", { x, y: 25 }, false);
    e.commit();
    expect(e.node(g).size.x).toBe(100);
    expect(e.node("1:2").size.x).toBe(100);
  });

  it("duplicate and paste create offset copies with fresh ids", () => {
    const e = setup();
    e.select(["1:2"]);
    e.duplicate();
    const [dup] = e.selection;
    expect(dup).not.toBe("1:2");
    expect(pos(e, dup!)).toEqual([120, 120]);
    e.copy();
    e.paste();
    expect(e.selection.size).toBe(1);
    expect(getChildren(e.doc, "1:1")).toHaveLength(3);
  });

  it("edits save to .fig and reopen", () => {
    const schema = decodeBinarySchema(ref.encodeBinarySchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT)));
    const base = decodeFig(encodeFig({
      magic: "fig-kiwi", version: 48, schema, message: sampleMessage(), compression: ["deflate-raw", "deflate-raw"], extraChunks: [],
    }));
    const doc: Document = figToDocument(base);
    const e = new Editor(doc, "0:1");
    e.transact(() => e.create("rectangle", { x: 10, y: 10 }, { x: 110, y: 60 }));
    const rect = [...e.selection][0]!;
    e.select(["0:3", rect]);
    e.group();
    const g = [...e.selection][0]!;

    const back = figToDocument(decodeFig(encodeFig(documentToFig(e.doc))));
    expect(back.nodes.get(g)?.type).toBe("GROUP");
    expect(back.nodes.get(rect)?.parentId).toBe(g);
    expect(back.nodes.get(rect)?.size).toEqual({ x: 100, y: 50 });
  });
});
