import { keyBetween } from "./fractional-index";
import type { Document, Node, NodeId, Transform } from "./types";

export const IDENTITY: Transform = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

export function createNode(partial: Pick<Node, "id" | "type"> & Partial<Node>): Node {
  return {
    name: partial.type,
    parentId: null,
    position: "",
    visible: true,
    locked: false,
    opacity: 1,
    blendMode: "PASS_THROUGH",
    transform: { ...IDENTITY },
    size: { x: 0, y: 0 },
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: "CENTER",
    effects: [],
    cornerRadius: 0,
    clipsContent: false,
    ...partial,
  };
}

export function createDocument(): Document {
  const root = createNode({ id: "0:0", type: "DOCUMENT", name: "Document" });
  const page = createNode({ id: "0:1", type: "CANVAS", name: "Page 1", parentId: root.id, position: keyBetween(null, null) });
  return {
    rootId: root.id,
    nodes: new Map([
      [root.id, root],
      [page.id, page],
    ]),
    images: new Map(),
  };
}

function getNode(doc: Document, id: NodeId): Node {
  const node = doc.nodes.get(id);
  if (!node) throw new Error(`node ${id} not found`);
  return node;
}

/** Children of `parentId` in z-order (back to front). O(n) — callers that walk the whole tree should use buildChildIndex. */
export function getChildren(doc: Document, parentId: NodeId): Node[] {
  const out: Node[] = [];
  for (const n of doc.nodes.values()) if (n.parentId === parentId) out.push(n);
  return out.sort(comparePosition);
}

export function buildChildIndex(doc: Document): Map<NodeId, Node[]> {
  const index = new Map<NodeId, Node[]>();
  for (const n of doc.nodes.values()) {
    if (n.parentId === null) continue;
    let list = index.get(n.parentId);
    if (!list) index.set(n.parentId, (list = []));
    list.push(n);
  }
  for (const list of index.values()) list.sort(comparePosition);
  return index;
}

function comparePosition(a: Node, b: Node): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1;
}

export function isAncestor(doc: Document, ancestorId: NodeId, id: NodeId): boolean {
  for (let cur = doc.nodes.get(id)?.parentId ?? null; cur !== null; cur = doc.nodes.get(cur)?.parentId ?? null) {
    if (cur === ancestorId) return true;
  }
  return false;
}

/**
 * Moves (or attaches) `id` under `parentId` at child slot `index`
 * (0 = back, children.length = front). Only the moved node's key changes.
 */
export function moveNode(doc: Document, id: NodeId, parentId: NodeId, index: number): void {
  const node = getNode(doc, id);
  getNode(doc, parentId);
  if (id === parentId || isAncestor(doc, id, parentId)) {
    throw new Error(`cannot move ${id} into its own subtree`);
  }
  const siblings = getChildren(doc, parentId).filter((n) => n.id !== id);
  const i = Math.max(0, Math.min(index, siblings.length));
  node.parentId = parentId;
  node.position = keyBetween(siblings[i - 1]?.position ?? null, siblings[i]?.position ?? null);
}

export function insertNode(doc: Document, node: Node, parentId: NodeId, index = Infinity): void {
  if (doc.nodes.has(node.id)) throw new Error(`node ${node.id} already exists`);
  doc.nodes.set(node.id, node);
  moveNode(doc, node.id, parentId, index);
}

/** Removes `id` and its whole subtree. */
export function removeNode(doc: Document, id: NodeId): void {
  if (id === doc.rootId) throw new Error("cannot remove document root");
  const children = buildChildIndex(doc);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    doc.nodes.delete(cur);
    for (const c of children.get(cur) ?? []) stack.push(c.id);
  }
}
