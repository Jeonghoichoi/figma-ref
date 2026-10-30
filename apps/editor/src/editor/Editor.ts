import {
  createNode,
  geometryPatch,
  getChildren,
  IDENTITY,
  isAncestor,
  keyBetween,
  moveNode,
  primitiveGeometry,
  removeNode,
  type Document,
  type Node,
  type NodeId,
  type NodeType,
  type Paint,
  type Transform,
  type Vec2,
} from "@figref/model";
import { Renderer, type HandleId, type Rect } from "@figref/renderer";

export type Tool = "select" | "hand" | "frame" | "rectangle" | "ellipse" | "line" | "text";

interface Snapshot {
  nodes: Map<NodeId, Node>;
  selection: ReadonlySet<NodeId>;
  pageId: NodeId;
}

const HISTORY_LIMIT = 200;
const FRAME_LIKE = new Set<NodeType>(["FRAME", "SYMBOL", "INSTANCE", "SECTION"]);
/** Fields whose change invalidates stored outline geometry. */
const SHAPE_FIELDS: (keyof Node)[] = ["size", "cornerRadius", "strokeWeight", "strokeAlign", "type"];

const GRAY: Paint = { type: "SOLID", color: { r: 0.851, g: 0.851, b: 0.851, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" };
const WHITE: Paint = { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" };
const BLACK: Paint = { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" };

export const DEFAULT_TEXT_STYLE = {
  fontFamily: "Noto Sans KR",
  fontStyle: "Regular",
  fontPostscript: "NotoSansKR-Regular",
  fontSize: 24,
  textAlignHorizontal: "LEFT" as const,
  textAlignVertical: "TOP" as const,
};

/**
 * Editing session over a Document: selection, tools, undo history and all
 * mutations. Node objects are replaced (never mutated) by `update`, so
 * history snapshots only need a shallow copy of the node map.
 */
export class Editor {
  readonly renderer: Renderer;
  pageId: NodeId;
  selection: ReadonlySet<NodeId> = new Set();
  tool: Tool = "select";
  /** Bumped on every change; React subscribes through this. */
  version = 0;
  dirty = false;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private listeners = new Set<() => void>();
  /** Nodes changed in the current edit (their group ancestors re-fit). */
  private touched = new Set<NodeId>();
  /** Containers that lost or gained children in the current edit (re-fit themselves). */
  private refit = new Set<NodeId>();
  private sessionID: number;
  private nextLocalID = 1;
  private clipboard: { doc: Document; nodes: Node[]; roots: NodeId[] } | null = null;

  constructor(readonly doc: Document, pageId: NodeId) {
    this.renderer = new Renderer(doc);
    this.pageId = pageId;
    // New ids live in a session id no existing node uses, so they never collide.
    let max = 0;
    for (const id of doc.nodes.keys()) max = Math.max(max, Number(id.split(":")[0]));
    this.sessionID = max + 1;
  }

  // ---- subscription -------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  // ---- history ------------------------------------------------------------

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private snapshot(): Snapshot {
    return { nodes: new Map(this.doc.nodes), selection: this.selection, pageId: this.pageId };
  }

  private restore(s: Snapshot): void {
    this.doc.nodes.clear();
    for (const [k, v] of s.nodes) this.doc.nodes.set(k, v);
    this.selection = new Set([...s.selection].filter((id) => this.doc.nodes.has(id)));
    this.pageId = s.pageId;
    this.renderer.invalidate();
    this.dirty = true;
    this.emit();
  }

  /** Records an undo point. Call once before a gesture's first live update. */
  checkpoint(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  /** One undoable edit: checkpoint, apply, then fix up derived state. */
  transact(fn: () => void): void {
    this.checkpoint();
    fn();
    this.commit();
  }

  /** Finishes an edit (also the end of a live gesture). */
  commit(): void {
    this.fixUpDerived();
    this.renderer.invalidate();
    this.dirty = true;
    this.emit();
  }

  /** Live update during a gesture: redraw without structural invalidation. */
  preview(): void {
    this.emit();
  }

  // ---- low-level mutation ---------------------------------------------------

  node(id: NodeId): Node {
    const n = this.doc.nodes.get(id);
    if (!n) throw new Error(`node ${id} not found`);
    return n;
  }

  /** Replaces a node with a patched copy; regenerates geometry when its shape changed. */
  update(id: NodeId, patch: Partial<Node>): void {
    const prev = this.node(id);
    let next: Node = { ...prev, ...patch };
    if (SHAPE_FIELDS.some((k) => k in patch && patch[k] !== prev[k])) next = { ...next, ...geometryPatch(next, prev) };
    if (next.type === "TEXT" && (("text" in patch && patch.text !== prev.text))) next.textLayout = undefined;
    this.doc.nodes.set(id, next);
    this.touched.add(id);
  }

  private newId(): NodeId {
    let id: NodeId;
    do id = `${this.sessionID}:${this.nextLocalID++}`;
    while (this.doc.nodes.has(id));
    return id;
  }

  /**
   * After edits: boolean results whose operands changed are dropped (the
   * renderer composites them live), and groups/booleans re-fit their bounds
   * to their children, as design tools keep them.
   */
  private fixUpDerived(): void {
    const containers = new Set<NodeId>();
    const climb = (start: NodeId | null | undefined) => {
      for (let p = start; p; p = this.doc.nodes.get(p)?.parentId ?? null) {
        const n = this.doc.nodes.get(p);
        if (!n || (n.type !== "GROUP" && n.type !== "BOOLEAN_OPERATION")) break;
        containers.add(p);
      }
    };
    for (const id of this.touched) climb(this.doc.nodes.get(id)?.parentId);
    for (const id of this.refit) climb(id);
    this.touched.clear();
    this.refit.clear();
    // Deepest first so outer groups see their inner groups' new bounds.
    const depth = (id: NodeId) => {
      let d = 0;
      for (let p = this.doc.nodes.get(id)?.parentId; p; p = this.doc.nodes.get(p)?.parentId ?? null) d++;
      return d;
    };
    for (const id of [...containers].sort((a, b) => depth(b) - depth(a))) {
      const n = this.doc.nodes.get(id);
      if (!n) continue;
      if (n.type === "BOOLEAN_OPERATION") this.doc.nodes.set(id, { ...n, fillGeometry: undefined, strokeGeometry: undefined });
      this.fitToChildren(id);
    }
  }

  private fitToChildren(id: NodeId): void {
    const group = this.node(id);
    const kids = getChildren(this.doc, id);
    if (!kids.length) {
      removeNode(this.doc, id); // empty groups disappear
      this.selection = new Set([...this.selection].filter((s) => s !== id));
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of kids) {
      for (const [u, v] of [[0, 0], [k.size.x, 0], [k.size.x, k.size.y], [0, k.size.y]] as const) {
        const p = applyT(k.transform, u, v);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
    if (Math.abs(x0) < 1e-6 && Math.abs(y0) < 1e-6 && Math.abs(x1 - group.size.x) < 1e-6 && Math.abs(y1 - group.size.y) < 1e-6) return;
    for (const k of kids) this.doc.nodes.set(k.id, { ...k, transform: { ...k.transform, m02: k.transform.m02 - x0, m12: k.transform.m12 - y0 } });
    const origin = applyT(group.transform, x0, y0);
    this.doc.nodes.set(id, { ...group, size: { x: x1 - x0, y: y1 - y0 }, transform: { ...group.transform, m02: origin.x, m12: origin.y } });
  }

  // ---- selection ------------------------------------------------------------

  select(ids: Iterable<NodeId>): void {
    this.selection = new Set([...ids].filter((id) => this.doc.nodes.has(id)));
    this.emit();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit();
  }

  setPage(id: NodeId): void {
    this.pageId = id;
    this.selection = new Set();
    this.emit();
  }

  pages(): Node[] {
    return this.renderer.childrenOf(this.doc.rootId).filter((n) => n.type === "CANVAS" && !n.raw?.internalOnly);
  }

  /**
   * What a click at a world point selects. Like common design tools: the
   * child of the nearest frame (so groups are picked whole); `deep` picks the
   * leaf; when the current selection is an ancestor in the path, go one
   * level below it (double-click to enter groups).
   */
  pick(x: number, y: number, mode: "click" | "deep" | "enter" = "click"): NodeId | null {
    const path = this.renderer.hitPath(this.pageId, x, y);
    if (!path.length) return null;
    if (mode === "deep") return path.at(-1)!.id;
    if (mode === "enter") {
      const i = path.findIndex((n) => this.selection.has(n.id));
      if (i >= 0 && i < path.length - 1) return path[i + 1]!.id;
    }
    // Keep siblings of the current selection pickable at their level (clicking inside an entered group).
    for (const sel of this.selection) {
      const parent = this.doc.nodes.get(sel)?.parentId;
      const i = path.findIndex((n) => n.parentId === parent);
      if (i >= 0 && parent !== this.pageId && !FRAME_LIKE.has(this.node(parent!).type)) return path[i]!.id;
    }
    let pick = path[0]!;
    for (let i = 0; i < path.length - 1; i++) {
      if (FRAME_LIKE.has(path[i]!.type)) pick = path[i + 1]!;
      else break;
    }
    return pick.id;
  }

  /** Nodes intersecting a world rect, at the level of `scope` (page or a frame). */
  nodesInRect(r: Rect, scope: NodeId): NodeId[] {
    return this.renderer.childrenOf(scope).filter((n) => {
      if (!n.visible || n.locked) return false;
      const b = this.renderer.bounds(n.id);
      return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
    }).map((n) => n.id);
  }

  /** Innermost frame-like container under a world point (for creating / dropping into). */
  containerAt(x: number, y: number, exclude: ReadonlySet<NodeId> = new Set()): NodeId {
    // Excluded nodes (the ones being dragged) are see-through, so the frame under them is found.
    const path = this.renderer.hitPath(this.pageId, x, y, exclude);
    let container = this.pageId;
    for (const n of path) {
      if (FRAME_LIKE.has(n.type)) container = n.id;
      else break; // a group or shape: stop at the frame that holds it
    }
    return container;
  }

  // ---- coordinates ------------------------------------------------------------

  /** Node space → world; the page counts as identity. */
  world(id: NodeId): Transform {
    return id === this.pageId || id === this.doc.rootId ? IDENTITY : this.renderer.worldTransform(id);
  }

  /** World point → `parent`'s local space. */
  toLocal(parent: NodeId, x: number, y: number): Vec2 {
    return applyT(invertT(this.world(parent)), x, y);
  }

  /** Moves a node under a new parent without changing where it appears. */
  private reparentKeepWorld(id: NodeId, parent: NodeId, index: number): void {
    const world = this.world(id);
    const oldParent = this.node(id).parentId;
    this.moveDetached(id, parent, index);
    this.doc.nodes.set(id, { ...this.node(id), transform: multiplyT(invertT(this.world(parent)), world) });
    this.touched.add(id);
    if (oldParent) this.refit.add(oldParent);
  }

  /**
   * moveNode() writes parentId/position into the node object in place. That
   * object is shared with undo snapshots, so move a fresh copy instead.
   */
  private moveDetached(id: NodeId, parent: NodeId, index: number): void {
    this.doc.nodes.set(id, { ...this.node(id) });
    moveNode(this.doc, id, parent, index);
  }

  // ---- operations ---------------------------------------------------------------

  /** Moves nodes by a world-space delta (live; wrap in checkpoint/commit). */
  translate(ids: Iterable<NodeId>, start: Map<NodeId, Transform>, dx: number, dy: number): void {
    for (const id of ids) {
      const n = this.node(id);
      const t0 = start.get(id) ?? n.transform;
      // Convert the world delta into the parent's space (parents may be rotated).
      const p = n.parentId ? invertT(this.world(n.parentId)) : IDENTITY;
      const lx = p.m00 * dx + p.m01 * dy, ly = p.m10 * dx + p.m11 * dy;
      this.update(id, { transform: { ...t0, m02: t0.m02 + lx, m12: t0.m12 + ly } });
    }
  }

  /** After a move gesture: nodes dropped over another frame move into it. */
  dropInto(ids: NodeId[], x: number, y: number): void {
    const target = this.containerAt(x, y, new Set(ids));
    for (const id of ids) {
      const n = this.node(id);
      if (n.parentId === target || isAncestor(this.doc, id, target) || id === target) continue;
      // Only nodes directly in a frame or on the page are re-homed; group members stay grouped.
      const parentType = n.parentId ? this.node(n.parentId).type : "CANVAS";
      if (parentType !== "CANVAS" && !FRAME_LIKE.has(parentType)) continue;
      this.reparentKeepWorld(id, target, Infinity);
    }
  }

  /**
   * Resizes by dragging a handle. `local` is the pointer in the node's own
   * space at gesture start; works for rotated nodes because all math is local.
   */
  resizeFromHandle(id: NodeId, start: Node, handle: HandleId, local: Vec2, keepAspect: boolean): void {
    let x0 = 0, y0 = 0, x1 = start.size.x, y1 = start.size.y;
    if (handle.includes("w")) x0 = local.x;
    if (handle.includes("e")) x1 = local.x;
    if (handle.includes("n")) y0 = local.y;
    if (handle.includes("s")) y1 = local.y;
    if (start.type === "LINE") { y0 = 0; y1 = 0; }
    if (keepAspect && start.size.x > 0 && start.size.y > 0) {
      const ratio = start.size.x / start.size.y;
      const w = x1 - x0, h = y1 - y0;
      if (handle === "n" || handle === "s") {
        const nw = Math.abs(h) * ratio * Math.sign(w || 1);
        x0 = (start.size.x - nw) / 2; x1 = x0 + nw;
      } else if (handle === "e" || handle === "w") {
        const nh = (Math.abs(w) / ratio) * Math.sign(h || 1);
        y0 = (start.size.y - nh) / 2; y1 = y0 + nh;
      } else if (Math.abs(w) / ratio > Math.abs(h)) {
        const nh = (Math.abs(w) / ratio) * Math.sign(h || 1);
        if (handle.includes("n")) y0 = y1 - nh; else y1 = y0 + nh;
      } else {
        const nw = Math.abs(h) * ratio * Math.sign(w || 1);
        if (handle.includes("w")) x0 = x1 - nw; else x1 = x0 + nw;
      }
    }
    const nx0 = Math.min(x0, x1), ny0 = Math.min(y0, y1);
    const w = Math.max(start.type === "LINE" ? 0 : 1, Math.abs(x1 - x0)), h = start.type === "LINE" ? 0 : Math.max(1, Math.abs(y1 - y0));
    const origin = applyT(start.transform, nx0, ny0);
    this.update(id, { size: { x: w, y: h }, transform: { ...start.transform, m02: origin.x, m12: origin.y } });
    this.scaleGroupChildren(id, start, w, h);
  }

  /**
   * Groups and booleans scale their contents when resized; frames don't
   * (their children keep their place). Always scales from the gesture-start
   * state so repeated pointer moves don't compound.
   */
  private scaleGroupChildren(id: NodeId, start: Node, w: number, h: number): void {
    if (start.type !== "GROUP" && start.type !== "BOOLEAN_OPERATION") return;
    const sx = start.size.x ? w / start.size.x : 1, sy = start.size.y ? h / start.size.y : 1;
    const scaleSubtree = (pid: NodeId) => {
      for (const k of this.resizeStart.get(pid) ?? []) {
        const t = k.transform;
        // Scale positions, sizes and the linear part, so rotated children stay consistent.
        this.update(k.id, {
          transform: { m00: t.m00, m01: t.m01, m10: t.m10, m11: t.m11, m02: t.m02 * sx, m12: t.m12 * sy },
          size: { x: k.size.x * sx, y: k.size.y * sy },
        });
        scaleSubtree(k.id);
      }
    };
    scaleSubtree(id);
  }

  /** Children (recursively, per container) at resize-gesture start. */
  private resizeStart = new Map<NodeId, Node[]>();

  private captureResizeStart(id: NodeId): void {
    this.resizeStart = new Map();
    const walk = (pid: NodeId) => {
      const kids = getChildren(this.doc, pid);
      this.resizeStart.set(pid, kids);
      for (const k of kids) if (k.type === "GROUP" || k.type === "BOOLEAN_OPERATION") walk(k.id);
    };
    walk(id);
  }

  beginResize(id: NodeId): Node {
    this.checkpoint();
    this.captureResizeStart(id);
    return this.node(id);
  }

  setPosition(id: NodeId, x: number, y: number): void {
    const t = this.node(id).transform;
    this.update(id, { transform: { ...t, m02: x, m12: y } });
  }

  setSize(id: NodeId, w: number, h: number): void {
    const n = this.node(id);
    this.captureResizeStart(id);
    this.update(id, { size: { x: Math.max(n.type === "LINE" ? 0 : 0.01, w), y: n.type === "LINE" ? 0 : Math.max(0.01, h) } });
    this.scaleGroupChildren(id, n, w, h);
  }

  /** Rotation in degrees, counter-clockwise as shown in design tools, about the node's center. */
  setRotation(id: NodeId, degrees: number): void {
    const n = this.node(id);
    const t = n.transform;
    const c = applyT(t, n.size.x / 2, n.size.y / 2);
    const a = (-degrees * Math.PI) / 180;
    const cos = Math.cos(a), sin = Math.sin(a);
    // Keep any flip already in the matrix.
    const flip = t.m00 * t.m11 - t.m01 * t.m10 < 0 ? -1 : 1;
    const m00 = cos, m01 = -sin * flip, m10 = sin, m11 = cos * flip;
    this.update(id, {
      transform: { m00, m01, m10, m11, m02: c.x - (m00 * n.size.x + m01 * n.size.y) / 2, m12: c.y - (m10 * n.size.x + m11 * n.size.y) / 2 },
    });
  }

  /** Creates a node from a world-space drag rectangle (or a click). */
  create(tool: Tool, from: Vec2, to: Vec2, keepAspect = false): NodeId {
    const parent = this.containerAt(from.x, from.y);
    const a = this.toLocal(parent, from.x, from.y);
    const b = this.toLocal(parent, to.x, to.y);
    const id = this.newId();
    const type: NodeType = tool === "frame" ? "FRAME" : tool === "ellipse" ? "ELLIPSE" : tool === "line" ? "LINE" : tool === "text" ? "TEXT" : "ROUNDED_RECTANGLE";
    const label = { FRAME: "Frame", ELLIPSE: "Ellipse", LINE: "Line", TEXT: "Text", ROUNDED_RECTANGLE: "Rectangle" }[type as string]!;
    const name = `${label} ${[...this.doc.nodes.values()].filter((n) => n.name.startsWith(label + " ")).length + 1}`;

    let node: Node;
    if (type === "LINE") {
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      node = createNode({
        id, type, name, size: { x: len, y: 0 }, strokes: [BLACK], strokeWeight: 1, strokeAlign: "CENTER",
        transform: { m00: Math.cos(ang), m01: -Math.sin(ang), m02: a.x, m10: Math.sin(ang), m11: Math.cos(ang), m12: a.y },
      });
    } else if (type === "TEXT") {
      node = createNode({
        id, type, name, size: { x: 1, y: 1 }, fills: [BLACK], strokeWeight: 1, strokeAlign: "OUTSIDE",
        transform: { ...IDENTITY, m02: a.x, m12: a.y },
        text: { characters: "", style: { ...DEFAULT_TEXT_STYLE } },
      });
    } else {
      let w = b.x - a.x, h = b.y - a.y;
      if (keepAspect) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = s * Math.sign(w || 1); h = s * Math.sign(h || 1);
      }
      node = createNode({
        id, type, name,
        size: { x: Math.max(1, Math.abs(w)), y: Math.max(1, Math.abs(h)) },
        transform: { ...IDENTITY, m02: Math.min(a.x, a.x + w), m12: Math.min(a.y, a.y + h) },
        fills: [type === "FRAME" ? WHITE : GRAY],
        strokeWeight: 1, strokeAlign: "INSIDE",
        clipsContent: type === "FRAME",
        blendMode: "PASS_THROUGH",
      });
      node.fillGeometry = primitiveGeometry(node);
    }
    const siblings = getChildren(this.doc, parent);
    node.parentId = parent;
    node.position = keyBetween(siblings.at(-1)?.position ?? null, null);
    this.doc.nodes.set(id, node);
    this.touched.add(id);
    this.selection = new Set([id]);
    return id;
  }

  /** Updates a node created by `create` while its creation drag continues. */
  resizeCreated(id: NodeId, from: Vec2, to: Vec2, keepAspect: boolean): void {
    const n = this.node(id);
    const a = this.toLocal(n.parentId!, from.x, from.y), b = this.toLocal(n.parentId!, to.x, to.y);
    if (n.type === "LINE") {
      let dx = b.x - a.x, dy = b.y - a.y;
      if (keepAspect) {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
        dx = Math.cos(ang) * len; dy = Math.sin(ang) * len;
      }
      const ang = Math.atan2(dy, dx);
      this.update(id, {
        size: { x: Math.hypot(dx, dy), y: 0 },
        transform: { m00: Math.cos(ang), m01: -Math.sin(ang), m02: a.x, m10: Math.sin(ang), m11: Math.cos(ang), m12: a.y },
      });
      return;
    }
    let w = b.x - a.x, h = b.y - a.y;
    if (keepAspect) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = s * Math.sign(w || 1); h = s * Math.sign(h || 1);
    }
    this.update(id, {
      size: { x: Math.max(1, Math.abs(w)), y: Math.max(1, Math.abs(h)) },
      transform: { ...n.transform, m02: Math.min(a.x, a.x + w), m12: Math.min(a.y, a.y + h) },
    });
  }

  deleteSelection(): void {
    if (!this.selection.size) return;
    this.transact(() => {
      for (const id of this.selection) {
        const n = this.doc.nodes.get(id);
        if (!n) continue;
        if (n.parentId) this.refit.add(n.parentId);
        removeNode(this.doc, id);
      }
      this.selection = new Set();
    });
  }

  /** Top-level selected nodes (dropping any whose ancestor is also selected), in z-order. */
  private selectionRoots(): Node[] {
    const ids = [...this.selection].filter((id) => ![...this.selection].some((o) => o !== id && isAncestor(this.doc, o, id)));
    return ids.map((id) => this.node(id)).sort((a, b) => (a.position < b.position ? -1 : 1));
  }

  private cloneSubtree(from: Document, rootId: NodeId, parent: NodeId, position: string, offset: number, keepRaw: boolean): NodeId {
    const ids = new Map<NodeId, NodeId>();
    const copy = (id: NodeId, newParent: NodeId, pos: string, isRoot: boolean) => {
      const src = from.nodes.get(id)!;
      const nid = this.newId();
      ids.set(id, nid);
      const t = src.transform;
      const node: Node = {
        ...src,
        id: nid,
        parentId: newParent,
        position: pos,
        transform: isRoot ? { ...t, m02: t.m02 + offset, m12: t.m12 + offset } : t,
        raw: keepRaw ? src.raw : undefined,
      };
      this.doc.nodes.set(nid, node);
      this.touched.add(nid);
      for (const c of getChildren(from, id)) copy(c.id, nid, c.position, false);
    };
    copy(rootId, parent, position, true);
    return ids.get(rootId)!;
  }

  duplicate(): void {
    const roots = this.selectionRoots();
    if (!roots.length) return;
    this.transact(() => {
      const created: NodeId[] = [];
      for (const n of roots) {
        const siblings = getChildren(this.doc, n.parentId!);
        const next = siblings[siblings.findIndex((s) => s.id === n.id) + 1];
        created.push(this.cloneSubtree(this.doc, n.id, n.parentId!, keyBetween(n.position, next?.position ?? null), 10, true));
      }
      this.selection = new Set(created);
    });
  }

  copy(): void {
    const roots = this.selectionRoots();
    if (!roots.length) return;
    // Snapshot the subtrees now; later edits must not change what gets pasted.
    const nodes: Node[] = [];
    const walk = (id: NodeId) => {
      nodes.push(this.node(id));
      for (const c of getChildren(this.doc, id)) walk(c.id);
    };
    roots.forEach((r) => walk(r.id));
    this.clipboard = { doc: this.doc, nodes, roots: roots.map((r) => r.id) };
  }

  paste(): void {
    const clip = this.clipboard;
    if (!clip) return;
    this.transact(() => {
      // Build a throwaway document view of the clipboard so subtrees resolve even if originals were deleted.
      const view: Document = { rootId: "", nodes: new Map(clip.nodes.map((n) => [n.id, n])), images: clip.doc.images };
      const sameDoc = clip.doc === this.doc;
      const created: NodeId[] = [];
      for (const rid of clip.roots) {
        const src = view.nodes.get(rid)!;
        const parent = sameDoc && src.parentId && this.doc.nodes.has(src.parentId) ? src.parentId : this.pageId;
        const last = getChildren(this.doc, parent).at(-1);
        // Raw data references this file's blobs, so it only survives a same-document paste.
        created.push(this.cloneSubtree(view, rid, parent, keyBetween(last?.position ?? null, null), 10, sameDoc));
      }
      if (!sameDoc) {
        for (const n of clip.nodes) for (const p of n.fills) {
          if (p.type === "IMAGE" && clip.doc.images.has(p.imageHash)) this.doc.images.set(p.imageHash, clip.doc.images.get(p.imageHash)!);
        }
      }
      this.selection = new Set(created);
    });
  }

  group(): void {
    const roots = this.selectionRoots();
    if (!roots.length) return;
    this.transact(() => {
      const parent = roots.at(-1)!.parentId!;
      const id = this.newId();
      const siblings = getChildren(this.doc, parent);
      const top = roots.filter((r) => r.parentId === parent).at(-1) ?? roots.at(-1)!;
      const next = siblings[siblings.findIndex((s) => s.id === top.id) + 1];
      const group = createNode({ id, type: "GROUP", name: `Group ${[...this.doc.nodes.values()].filter((n) => n.type === "GROUP").length + 1}` });
      group.parentId = parent;
      group.position = keyBetween(top.position, next?.position ?? null);
      group.size = { x: 1, y: 1 };
      this.doc.nodes.set(id, group);
      for (const r of roots) this.reparentKeepWorld(r.id, id, Infinity);
      this.fitToChildren(id);
      this.refit.add(id);
      this.selection = new Set([id]);
    });
  }

  ungroup(): void {
    const groups = this.selectionRoots().filter((n) => n.type === "GROUP" || n.type === "BOOLEAN_OPERATION" || n.type === "FRAME");
    if (!groups.length) return;
    this.transact(() => {
      const released: NodeId[] = [];
      for (const g of groups) {
        const parent = g.parentId!;
        const index = getChildren(this.doc, parent).findIndex((s) => s.id === g.id);
        getChildren(this.doc, g.id).forEach((c, i) => {
          this.reparentKeepWorld(c.id, parent, index + i);
          released.push(c.id);
        });
        removeNode(this.doc, g.id);
      }
      this.selection = new Set(released);
    });
  }

  /** z-order: "forward"/"backward" by one, "front"/"back" to the end. */
  reorder(dir: "forward" | "backward" | "front" | "back"): void {
    const roots = this.selectionRoots();
    if (!roots.length) return;
    this.transact(() => {
      const ordered = dir === "forward" || dir === "front" ? [...roots].reverse() : roots;
      for (const n of ordered) {
        const siblings = getChildren(this.doc, n.parentId!);
        const i = siblings.findIndex((s) => s.id === n.id);
        const target = dir === "front" ? siblings.length : dir === "back" ? 0 : dir === "forward" ? i + 2 : i - 1;
        this.moveDetached(n.id, n.parentId!, Math.max(0, target));
      }
    });
  }

  /** Moves `id` in the layer tree to `index` under `parent` (layer panel drag). */
  moveInTree(id: NodeId, parent: NodeId, index: number): void {
    if (id === parent || isAncestor(this.doc, id, parent)) return;
    this.transact(() => this.reparentKeepWorld(id, parent, index));
  }

  rename(id: NodeId, name: string): void {
    this.transact(() => this.update(id, { name }));
  }

  toggle(id: NodeId, key: "visible" | "locked"): void {
    this.transact(() => this.update(id, { [key]: !this.node(id)[key] }));
  }

  /** Measures text with the live font and sizes the box to fit (auto-width text). */
  fitText(id: NodeId, measure: (text: string, style: NonNullable<Node["text"]>["style"]) => { w: number; h: number }): void {
    const n = this.node(id);
    if (!n.text) return;
    const { w, h } = measure(n.text.characters || " ", n.text.style);
    this.update(id, { size: { x: Math.ceil(w), y: Math.ceil(h) } });
  }
}

function applyT(t: Transform, x: number, y: number): Vec2 {
  return { x: t.m00 * x + t.m01 * y + t.m02, y: t.m10 * x + t.m11 * y + t.m12 };
}

export function multiplyT(a: Transform, b: Transform): Transform {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10, m01: a.m00 * b.m01 + a.m01 * b.m11, m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10, m11: a.m10 * b.m01 + a.m11 * b.m11, m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

export function invertT(t: Transform): Transform {
  const det = t.m00 * t.m11 - t.m01 * t.m10;
  if (Math.abs(det) < 1e-12) return IDENTITY;
  const i00 = t.m11 / det, i01 = -t.m01 / det, i10 = -t.m10 / det, i11 = t.m00 / det;
  return { m00: i00, m01: i01, m02: -(i00 * t.m02 + i01 * t.m12), m10: i10, m11: i11, m12: -(i10 * t.m02 + i11 * t.m12) };
}

export { applyT };
