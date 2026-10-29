import { describe, expect, it } from "vitest";
import { createDocument, createNode, getChildren, insertNode, keyBetween, keysBetween, moveNode, removeNode } from "../src";

describe("fractional index", () => {
  it("produces keys strictly between bounds", () => {
    const cases: [string | null, string | null][] = [
      [null, null], [null, "P"], ["P", null], ["A", "B"], ["A", "A#"], ["~", null], [null, "\""], ["A~~", "B"],
      // keys observed in a real file
      [" }", "!O"], [null, " }"], ["!O", "\""], ["%", "~"],
    ];
    for (const [a, b] of cases) {
      const k = keyBetween(a, b);
      if (a !== null) expect(k > a).toBe(true);
      if (b !== null) expect(k < b).toBe(true);
    }
  });

  it("stays ordered under repeated insertion at both ends and the middle", () => {
    let keys = keysBetween(null, null, 50);
    for (let i = 0; i < 200; i++) {
      keys = [keyBetween(null, keys[0]!), ...keys, keyBetween(keys.at(-1)!, null)];
      const mid = keys.length >> 1;
      keys.splice(mid, 0, keyBetween(keys[mid - 1]!, keys[mid]!));
    }
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("tree", () => {
  it("inserts, reorders and removes subtrees", () => {
    const doc = createDocument();
    const page = "0:1";
    for (const id of ["1:1", "1:2", "1:3"]) insertNode(doc, createNode({ id, type: "RECTANGLE" }), page);
    expect(getChildren(doc, page).map((n) => n.id)).toEqual(["1:1", "1:2", "1:3"]);

    moveNode(doc, "1:3", page, 0);
    expect(getChildren(doc, page).map((n) => n.id)).toEqual(["1:3", "1:1", "1:2"]);

    insertNode(doc, createNode({ id: "1:4", type: "FRAME" }), page);
    moveNode(doc, "1:1", "1:4", 0);
    expect(() => moveNode(doc, "1:4", "1:1", 0)).toThrow(/own subtree/);

    removeNode(doc, "1:4");
    expect(doc.nodes.has("1:1")).toBe(false);
    expect(getChildren(doc, page).map((n) => n.id)).toEqual(["1:3", "1:2"]);
  });
});
