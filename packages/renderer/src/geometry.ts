import type { Geometry, Node, PathCommand, Transform } from "@figref/model";

const pathCache = new WeakMap<PathCommand[], Path2D>();

export function toPath2D(commands: PathCommand[]): Path2D {
  let p = pathCache.get(commands);
  if (p) return p;
  p = new Path2D();
  for (const c of commands) {
    switch (c.op) {
      case "M": p.moveTo(c.x, c.y); break;
      case "L": p.lineTo(c.x, c.y); break;
      case "Q": p.quadraticCurveTo(c.x1, c.y1, c.x, c.y); break;
      case "C": p.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y); break;
      case "Z": p.closePath(); break;
    }
  }
  pathCache.set(commands, p);
  return p;
}

/** Fill outline: stored geometry when present, else a (rounded) rect/ellipse from size. */
export function fillPaths(node: Node): { path: Path2D; rule: CanvasFillRule }[] {
  if (node.fillGeometry?.length) return node.fillGeometry.map(geom);
  const p = new Path2D();
  const { x: w, y: h } = node.size;
  if (node.type === "ELLIPSE") p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (node.cornerRadius > 0) p.roundRect(0, 0, w, h, Math.min(node.cornerRadius, w / 2, h / 2));
  else p.rect(0, 0, w, h);
  return [{ path: p, rule: "nonzero" }];
}

function geom(g: Geometry): { path: Path2D; rule: CanvasFillRule } {
  return { path: toPath2D(g.commands), rule: g.windingRule === "ODD" ? "evenodd" : "nonzero" };
}

export function geometryPaths(gs: Geometry[]): { path: Path2D; rule: CanvasFillRule }[] {
  return gs.map(geom);
}

/** .fig matrices map (x, y) → (m00·x + m01·y + m02, m10·x + m11·y + m12); canvas takes (a, b, c, d, e, f) column-wise. */
export function applyTransform(ctx: CanvasRenderingContext2D, t: Transform): void {
  ctx.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
}

export function multiply(a: Transform, b: Transform): Transform {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10, m01: a.m00 * b.m01 + a.m01 * b.m11, m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10, m11: a.m10 * b.m01 + a.m11 * b.m11, m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

export function invert(t: Transform): Transform {
  const det = t.m00 * t.m11 - t.m01 * t.m10;
  if (Math.abs(det) < 1e-12) return { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const i00 = t.m11 / det, i01 = -t.m01 / det, i10 = -t.m10 / det, i11 = t.m00 / det;
  return { m00: i00, m01: i01, m02: -(i00 * t.m02 + i01 * t.m12), m10: i10, m11: i11, m12: -(i10 * t.m02 + i11 * t.m12) };
}

export function apply(t: Transform, x: number, y: number): { x: number; y: number } {
  return { x: t.m00 * x + t.m01 * y + t.m02, y: t.m10 * x + t.m11 * y + t.m12 };
}
