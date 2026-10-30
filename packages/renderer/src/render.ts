import { buildChildIndex, IDENTITY, type Document, type Node, type NodeId, type Transform } from "@figref/model";
import { apply, applyTransform, fillPaths, geometryPaths, invert, multiply, toPath2D } from "./geometry";
import { compositeOp, fillWithPaint, rgba, type ImageSource } from "./paint";

/** screen = world · zoom + (x, y), in CSS pixels. */
export interface Viewport {
  zoom: number;
  x: number;
  y: number;
}

export interface RenderOptions {
  images: Map<string, ImageSource>;
  selection?: ReadonlySet<NodeId>;
  hover?: NodeId | null;
  background?: string;
  /** Draw resize handles around a single selection. */
  handles?: boolean;
  /** Rubber-band selection rectangle, world space. */
  marquee?: Rect | null;
  /** Nodes not drawn by the scene (e.g. text being edited in an overlay). */
  hidden?: ReadonlySet<NodeId>;
  /** Frame name labels above top-level frames (default true). */
  labels?: boolean;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const HANDLES: { id: HandleId; u: number; v: number }[] = [
  { id: "nw", u: 0, v: 0 }, { id: "n", u: 0.5, v: 0 }, { id: "ne", u: 1, v: 0 }, { id: "e", u: 1, v: 0.5 },
  { id: "se", u: 1, v: 1 }, { id: "s", u: 0.5, v: 1 }, { id: "sw", u: 0, v: 1 }, { id: "w", u: 0, v: 0.5 },
];
const HANDLE_SIZE = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SELECTION = "#0d99ff";

/**
 * Canvas2D scene renderer. Draws a page in painter's order and answers
 * geometry queries (hit testing, bounds) against the same transforms.
 */
export class Renderer {
  // Ids, not Node objects: editors replace node objects on every edit, and
  // only structural changes (insert/move/remove/reorder) need invalidate().
  private children = new Map<NodeId, NodeId[]>();

  constructor(private doc: Document) {
    this.invalidate();
  }

  /** Call after any structural change (insert/move/remove). */
  invalidate(): void {
    this.children = new Map([...buildChildIndex(this.doc)].map(([k, v]) => [k, v.map((n) => n.id)]));
  }

  childrenOf(id: NodeId): Node[] {
    const out: Node[] = [];
    for (const c of this.children.get(id) ?? []) {
      const n = this.doc.nodes.get(c);
      if (n) out.push(n);
    }
    return out;
  }

  render(ctx: CanvasRenderingContext2D, pageId: NodeId, view: Viewport, opts: RenderOptions): void {
    const { width, height } = ctx.canvas;
    const dpr = ctx.getTransform().a || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = opts.background ?? "#f5f5f5";
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y);
    for (const child of this.childrenOf(pageId)) this.drawNode(ctx, child, opts);
    ctx.restore();

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (opts.labels !== false) this.drawFrameLabels(ctx, pageId, view, opts);
    if (opts.hover && !opts.selection?.has(opts.hover)) this.outline(ctx, opts.hover, view, 1);
    for (const id of opts.selection ?? []) this.outline(ctx, id, view, 1.5);
    if (opts.handles && opts.selection?.size === 1) this.drawHandles(ctx, [...opts.selection][0]!, view);
    if (opts.marquee) {
      const m = opts.marquee;
      ctx.fillStyle = "rgba(13, 153, 255, 0.08)";
      ctx.strokeStyle = SELECTION;
      ctx.lineWidth = 1;
      ctx.fillRect(m.x * view.zoom + view.x, m.y * view.zoom + view.y, m.w * view.zoom, m.h * view.zoom);
      ctx.strokeRect(m.x * view.zoom + view.x + 0.5, m.y * view.zoom + view.y + 0.5, m.w * view.zoom, m.h * view.zoom);
    }
    ctx.restore();
  }

  private drawNode(ctx: CanvasRenderingContext2D, node: Node, opts: RenderOptions): void {
    if (!node.visible || node.opacity <= 0 || opts.hidden?.has(node.id)) return;
    ctx.save();
    applyTransform(ctx, node.transform);
    ctx.globalAlpha *= node.opacity;
    // Approximation: PASS_THROUGH/NORMAL composite normally; other modes apply per draw call, not per layer.
    if (node.blendMode !== "PASS_THROUGH") ctx.globalCompositeOperation = compositeOp(node.blendMode);

    const blur = node.effects.find((e) => e.visible && e.type === "FOREGROUND_BLUR");
    if (blur) ctx.filter = `blur(${(blur.radius / 2) * scaleOf(ctx)}px)`;

    if (node.type === "TEXT") {
      this.drawText(ctx, node, opts);
    } else if (node.type === "BOOLEAN_OPERATION" && !node.fillGeometry?.length) {
      this.drawBooleanLive(ctx, node, opts);
    } else {
      const paths = fillPaths(node);
      this.drawFills(ctx, node, paths, opts);
      // Boolean results are pre-baked into fillGeometry; operands are not drawn.
      if (node.type !== "BOOLEAN_OPERATION") {
        // Clip only the children; the frame's own stroke is drawn unclipped.
        ctx.save();
        if (node.clipsContent) for (const p of paths) ctx.clip(p.path, p.rule);
        for (const child of this.childrenOf(node.id)) this.drawNode(ctx, child, opts);
        ctx.restore();
      }
      this.drawStrokes(ctx, node, paths, opts);
    }
    ctx.restore();
  }

  /**
   * A boolean whose stored result went stale (an operand was edited) is
   * composited from its operands: union = over, subtract = destination-out,
   * intersect = destination-in, exclude = xor. The mask then clips the fills.
   */
  private drawBooleanLive(ctx: CanvasRenderingContext2D, node: Node, opts: RenderOptions): void {
    const op = (node.raw?.booleanOperation as string | undefined) ?? "UNION";
    const { width, height } = ctx.canvas;
    const mask = new OffscreenCanvas(width, height);
    const m = mask.getContext("2d")!;
    m.setTransform(ctx.getTransform());
    this.childrenOf(node.id).filter((c) => c.visible).forEach((child, i) => {
      m.globalCompositeOperation =
        i === 0 || op === "UNION" ? "source-over" : op === "SUBTRACT" ? "destination-out" : op === "INTERSECT" ? "destination-in" : "xor";
      const t = child.transform;
      const path = new Path2D();
      for (const p of fillPaths(child)) path.addPath(p.path, new DOMMatrix([t.m00, t.m10, t.m01, t.m11, t.m02, t.m12]));
      m.fillStyle = "#000";
      m.fill(path);
    });
    const layer = new OffscreenCanvas(width, height);
    const l = layer.getContext("2d")!;
    l.setTransform(ctx.getTransform());
    const rect = new Path2D();
    rect.rect(-1e6, -1e6, 2e6, 2e6);
    for (const paint of node.fills) fillWithPaint(l as unknown as CanvasRenderingContext2D, paint, node.size, [{ path: rect, rule: "nonzero" }], opts.images);
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = "destination-in";
    l.drawImage(mask, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  private drawFills(ctx: CanvasRenderingContext2D, node: Node, paths: ReturnType<typeof fillPaths>, opts: RenderOptions): void {
    const shadow = node.effects.find((e) => e.visible && e.type === "DROP_SHADOW");
    let first = true;
    for (const paint of node.fills) {
      if (!paint.visible) continue;
      ctx.save();
      if (shadow && first) {
        // Canvas shadows ignore the current transform, so convert to device pixels.
        const s = scaleOf(ctx);
        ctx.shadowColor = rgba(shadow.color);
        ctx.shadowBlur = shadow.radius * s;
        ctx.shadowOffsetX = shadow.offset.x * s;
        ctx.shadowOffsetY = shadow.offset.y * s;
      }
      fillWithPaint(ctx, paint, node.size, paths, opts.images);
      ctx.restore();
      first = false;
    }
  }

  private drawStrokes(ctx: CanvasRenderingContext2D, node: Node, paths: ReturnType<typeof fillPaths>, opts: RenderOptions): void {
    if (!node.strokes.some((p) => p.visible) || node.strokeWeight <= 0) return;
    if (node.strokeGeometry?.length) {
      // Stored stroke geometry is the outlined stroke: fill it.
      const outline = geometryPaths(node.strokeGeometry);
      for (const paint of node.strokes) fillWithPaint(ctx, paint, node.size, outline, opts.images);
      return;
    }
    for (const paint of node.strokes) {
      if (!paint.visible || paint.type !== "SOLID") continue;
      ctx.save();
      ctx.strokeStyle = rgba(paint.color, paint.opacity);
      ctx.lineWidth = node.strokeAlign === "CENTER" ? node.strokeWeight : node.strokeWeight * 2;
      for (const p of paths) {
        if (node.strokeAlign === "INSIDE") {
          ctx.save();
          ctx.clip(p.path, p.rule);
          ctx.stroke(p.path);
          ctx.restore();
        } else {
          ctx.stroke(p.path);
        }
      }
      ctx.restore();
    }
  }

  private drawText(ctx: CanvasRenderingContext2D, node: Node, opts: RenderOptions): void {
    const layout = node.textLayout;
    if (layout?.glyphs.length) {
      for (const g of layout.glyphs) {
        if (g.commands.length < 2) continue; // spaces
        const path = toPath2D(g.commands);
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.scale(g.fontSize, -g.fontSize);
        for (const paint of (g.styleID && layout.styleFills[g.styleID]) || node.fills) {
          fillWithPaint(ctx, paint, node.size, [{ path, rule: "nonzero" }], opts.images);
        }
        ctx.restore();
      }
      return;
    }
    // No stored layout (new or edited text): live font rendering, explicit newlines only.
    const t = node.text;
    if (!t) return;
    const { style } = t;
    const lh = style.lineHeight?.units === "PIXELS" ? style.lineHeight.value
      : style.lineHeight?.units === "PERCENT" ? (style.lineHeight.value / 100) * style.fontSize
      : style.fontSize * 1.2;
    ctx.font = `${fontWeight(style.fontStyle)} ${style.fontSize}px "${style.fontFamily}", sans-serif`;
    if (style.letterSpacing && "letterSpacing" in ctx) {
      const px = style.letterSpacing.units === "PERCENT" ? (style.letterSpacing.value / 100) * style.fontSize : style.letterSpacing.value;
      (ctx as any).letterSpacing = `${px}px`;
    }
    ctx.textBaseline = "alphabetic";
    const solid = node.fills.find((p) => p.visible && p.type === "SOLID");
    ctx.fillStyle = solid && solid.type === "SOLID" ? rgba(solid.color, solid.opacity) : "#000";
    t.characters.split("\n").forEach((line, i) => {
      const w = ctx.measureText(line).width;
      const x = style.textAlignHorizontal === "CENTER" ? (node.size.x - w) / 2 : style.textAlignHorizontal === "RIGHT" ? node.size.x - w : 0;
      ctx.fillText(line, x, lh * i + (lh + style.fontSize * 0.7) / 2);
    });
  }

  /** Screen rects of the frame name labels from the last render (labels are drag handles for frames). */
  private labelRects: { id: NodeId; x: number; y: number; w: number; h: number }[] = [];

  private drawFrameLabels(ctx: CanvasRenderingContext2D, pageId: NodeId, view: Viewport, opts: RenderOptions): void {
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    this.labelRects = [];
    for (const n of this.childrenOf(pageId)) {
      if (!n.visible || !["FRAME", "SYMBOL", "INSTANCE", "SECTION"].includes(n.type)) continue;
      const p = apply(n.transform, 0, 0);
      const x = p.x * view.zoom + view.x, y = p.y * view.zoom + view.y - 4;
      ctx.fillStyle = opts.selection?.has(n.id) ? SELECTION : "#808080";
      ctx.fillText(n.name, x, y);
      this.labelRects.push({ id: n.id, x, y: y - 14, w: ctx.measureText(n.name).width, h: 14 });
    }
  }

  /** Frame whose name label is at a screen point (front-most first). */
  frameLabelAt(sx: number, sy: number): NodeId | null {
    for (let i = this.labelRects.length - 1; i >= 0; i--) {
      const r = this.labelRects[i]!;
      if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return r.id;
    }
    return null;
  }

  /** Screen-space positions of the resize handles of `id`. */
  handlePositions(id: NodeId, view: Viewport): { id: HandleId; x: number; y: number }[] {
    const node = this.doc.nodes.get(id);
    if (!node) return [];
    const t = this.worldTransform(id);
    return HANDLES.map((h) => {
      const p = apply(t, h.u * node.size.x, h.v * node.size.y);
      return { id: h.id, x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y };
    });
  }

  private drawHandles(ctx: CanvasRenderingContext2D, id: NodeId, view: Viewport): void {
    const node = this.doc.nodes.get(id);
    if (!node || node.locked) return;
    // Lines only get their two end handles.
    const handles = this.handlePositions(id, view).filter((h) => node.type !== "LINE" || h.id === "w" || h.id === "e");
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = SELECTION;
    ctx.lineWidth = 1;
    for (const h of handles) {
      ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(h.x - HANDLE_SIZE / 2 + 0.5, h.y - HANDLE_SIZE / 2 + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
    }
  }

  private outline(ctx: CanvasRenderingContext2D, id: NodeId, view: Viewport, width: number): void {
    const node = this.doc.nodes.get(id);
    if (!node) return;
    const t = this.worldTransform(id);
    const pts = [[0, 0], [node.size.x, 0], [node.size.x, node.size.y], [0, node.size.y]].map(([x, y]) => apply(t, x!, y!));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, p.x * view.zoom + view.x, p.y * view.zoom + view.y));
    ctx.closePath();
    ctx.strokeStyle = SELECTION;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /** Node space → page (world) space. */
  worldTransform(id: NodeId): Transform {
    let t: Transform = IDENTITY;
    for (let n = this.doc.nodes.get(id); n && n.type !== "CANVAS" && n.type !== "DOCUMENT"; n = n.parentId ? this.doc.nodes.get(n.parentId) : undefined) {
      t = multiply(n.transform, t);
    }
    return t;
  }

  /** Axis-aligned world bounds of a node (its own box, not descendants). */
  bounds(id: NodeId): Rect {
    const node = this.doc.nodes.get(id)!;
    const t = this.worldTransform(id);
    const pts = [[0, 0], [node.size.x, 0], [node.size.x, node.size.y], [0, node.size.y]].map(([x, y]) => apply(t, x!, y!));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }

  pageBounds(pageId: NodeId): Rect | null {
    const rects = this.childrenOf(pageId).filter((n) => n.visible).map((n) => this.bounds(n.id));
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  }

  /**
   * Chain from the page's child down to the deepest visible, unlocked node
   * under a world-space point (empty if nothing is hit). Editors pick which
   * level of the chain a click selects.
   */
  hitPath(pageId: NodeId, x: number, y: number, exclude?: ReadonlySet<NodeId>): Node[] {
    const leaf = this.hitTest(pageId, x, y, exclude);
    if (!leaf) return [];
    const chain: Node[] = [];
    for (let n = this.doc.nodes.get(leaf); n && n.id !== pageId; n = n.parentId ? this.doc.nodes.get(n.parentId) : undefined) chain.unshift(n);
    return chain;
  }

  /** Topmost, deepest visible node under a world-space point. */
  hitTest(pageId: NodeId, x: number, y: number, exclude?: ReadonlySet<NodeId>): NodeId | null {
    const visit = (node: Node, parent: Transform): NodeId | null => {
      if (!node.visible || node.locked || exclude?.has(node.id)) return null;
      const t = multiply(parent, node.transform);
      const p = apply(invert(t), x, y);
      const tol = 4; // lines have zero height
      const inside = p.x >= -tol && p.y >= -tol && p.x <= node.size.x + tol && p.y <= node.size.y + tol;
      if (node.clipsContent && !inside) return null;
      if (node.type !== "BOOLEAN_OPERATION") {
        const kids = this.childrenOf(node.id);
        for (let i = kids.length - 1; i >= 0; i--) {
          const hit = visit(kids[i]!, t);
          if (hit) return hit;
        }
      }
      return inside && node.type !== "GROUP" ? node.id : null;
    };
    const kids = this.childrenOf(pageId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const hit = visit(kids[i]!, IDENTITY);
      if (hit) return hit;
    }
    return null;
  }
}

function scaleOf(ctx: CanvasRenderingContext2D): number {
  const m = ctx.getTransform();
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra ?light|ultra ?light/i, 200], [/light/i, 300], [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600], [/extra ?bold|ultra ?bold/i, 800], [/black|heavy/i, 900], [/bold/i, 700],
];

export function fontWeight(style: string): number {
  return WEIGHTS.find(([re]) => re.test(style))?.[1] ?? 400;
}
