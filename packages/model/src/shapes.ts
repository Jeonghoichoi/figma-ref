import type { Geometry, Node, PathCommand } from "./types";

// Outline geometry for parametric shapes, matching what real .fig files store
// (docs/fig-format.md), so edited shapes save with valid fillGeometry.

const KAPPA = 0.5522847498307936; // cubic approximation of a quarter circle

/** Types whose outline is fully determined by size + parameters. */
const PRIMITIVES = new Set<Node["type"]>([
  "RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE", "STAR", "REGULAR_POLYGON", "FRAME", "SYMBOL", "INSTANCE", "SECTION",
]);

export function isPrimitive(type: Node["type"]): boolean {
  return PRIMITIVES.has(type);
}

export function rectPath(w: number, h: number, r = 0): PathCommand[] {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r === 0) {
    // Same command sequence as stored files: closes with an explicit line to the origin.
    return [{ op: "M", x: 0, y: 0 }, { op: "L", x: w, y: 0 }, { op: "L", x: w, y: h }, { op: "L", x: 0, y: h }, { op: "L", x: 0, y: 0 }, { op: "Z" }];
  }
  const k = r * (1 - KAPPA);
  return [
    { op: "M", x: r, y: 0 },
    { op: "L", x: w - r, y: 0 },
    { op: "C", x1: w - k, y1: 0, x2: w, y2: k, x: w, y: r },
    { op: "L", x: w, y: h - r },
    { op: "C", x1: w, y1: h - k, x2: w - k, y2: h, x: w - r, y: h },
    { op: "L", x: r, y: h },
    { op: "C", x1: k, y1: h, x2: 0, y2: h - k, x: 0, y: h - r },
    { op: "L", x: 0, y: r },
    { op: "C", x1: 0, y1: k, x2: k, y2: 0, x: r, y: 0 },
    { op: "Z" },
  ];
}

/** Starts at the right-middle point and runs clockwise (y down), as stored files do. */
export function ellipsePath(w: number, h: number): PathCommand[] {
  const rx = w / 2, ry = h / 2, kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    { op: "M", x: w, y: ry },
    { op: "C", x1: w, y1: ry + ky, x2: rx + kx, y2: h, x: rx, y: h },
    { op: "C", x1: rx - kx, y1: h, x2: 0, y2: ry + ky, x: 0, y: ry },
    { op: "C", x1: 0, y1: ry - ky, x2: rx - kx, y2: 0, x: rx, y: 0 },
    { op: "C", x1: rx + kx, y1: 0, x2: w, y2: ry - ky, x: w, y: ry },
    { op: "Z" },
  ];
}

/**
 * Star inscribed in the size ellipse, first point at the top. Verified
 * against a stored 5-point star (389×393, innerScale 0.382): every vertex
 * matches to 3 decimals.
 */
export function starPath(w: number, h: number, count = 5, innerScale = 0.381966): PathCommand[] {
  const cx = w / 2, cy = h / 2;
  const out: PathCommand[] = [];
  for (let i = 0; i < count * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / count;
    const s = i % 2 ? innerScale : 1;
    out.push({ op: i ? "L" : "M", x: cx + cx * s * Math.cos(a), y: cy + cy * s * Math.sin(a) });
  }
  out.push({ op: "L", x: cx, y: 0 }, { op: "Z" });
  return out;
}

export function polygonPath(w: number, h: number, count = 3): PathCommand[] {
  const cx = w / 2, cy = h / 2;
  const out: PathCommand[] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    out.push({ op: i ? "L" : "M", x: cx + cx * Math.cos(a), y: cy + cy * Math.sin(a) });
  }
  out.push({ op: "L", x: cx, y: 0 }, { op: "Z" });
  return out;
}

/** Fresh fill outline for a primitive node, or undefined for non-primitives. */
export function primitiveGeometry(node: Node): Geometry[] | undefined {
  const { x: w, y: h } = node.size;
  const count = (node.raw?.count as number | undefined) ?? undefined;
  let commands: PathCommand[];
  switch (node.type) {
    case "ELLIPSE": commands = ellipsePath(w, h); break;
    case "STAR": commands = starPath(w, h, count ?? 5, (node.raw?.starInnerScale as number | undefined) ?? 0.381966); break;
    case "REGULAR_POLYGON": commands = polygonPath(w, h, count ?? 3); break;
    default:
      if (!isPrimitive(node.type)) return undefined;
      commands = rectPath(w, h, node.cornerRadius);
  }
  return [{ windingRule: "NONZERO", commands }];
}

export function scaleGeometry(gs: Geometry[] | undefined, sx: number, sy: number): Geometry[] | undefined {
  return gs?.map((g) => ({
    ...g,
    commands: g.commands.map((c): PathCommand => {
      switch (c.op) {
        case "Z": return c;
        case "M": case "L": return { ...c, x: c.x * sx, y: c.y * sy };
        case "Q": return { ...c, x1: c.x1 * sx, y1: c.y1 * sy, x: c.x * sx, y: c.y * sy };
        case "C": return { ...c, x1: c.x1 * sx, y1: c.y1 * sy, x2: c.x2 * sx, y2: c.y2 * sy, x: c.x * sx, y: c.y * sy };
      }
    }),
  }));
}

/**
 * Geometry fields to apply when a node's shape-defining properties change.
 *
 * - Primitives: regenerate the fill outline; drop the stored stroke outline
 *   (renderers stroke the fill path instead).
 * - Vectors/booleans: no parametric source here, so scale what is stored.
 * - Lines: the stored stroke outline is a rectangle around the line; drop it.
 */
export function geometryPatch(node: Node, previous: Node): Pick<Node, "fillGeometry" | "strokeGeometry"> {
  if (isPrimitive(node.type)) {
    // Frames without stored geometry (e.g. groups converted to frames) stay without.
    const fillGeometry = previous.fillGeometry || node.type !== "FRAME" ? primitiveGeometry(node) : undefined;
    return { fillGeometry, strokeGeometry: undefined };
  }
  if (node.type === "LINE") return { fillGeometry: node.fillGeometry, strokeGeometry: undefined };
  if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") {
    const sx = previous.size.x ? node.size.x / previous.size.x : 1;
    const sy = previous.size.y ? node.size.y / previous.size.y : 1;
    return { fillGeometry: scaleGeometry(node.fillGeometry, sx, sy), strokeGeometry: scaleGeometry(node.strokeGeometry, sx, sy) };
  }
  return { fillGeometry: node.fillGeometry, strokeGeometry: node.strokeGeometry };
}
