import type { BlendMode, Color, Paint, Vec2 } from "@figref/model";
import { apply, invert } from "./geometry";

export type ImageSource = CanvasImageSource & { width: number; height: number };

export function rgba(c: Color, opacity = 1): string {
  const to8 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${to8(c.r)}, ${to8(c.g)}, ${to8(c.b)}, ${c.a * opacity})`;
}

const BLEND: Partial<Record<BlendMode, GlobalCompositeOperation>> = {
  MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", DARKEN: "darken", LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge", COLOR_BURN: "color-burn", HARD_LIGHT: "hard-light", SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference", EXCLUSION: "exclusion", HUE: "hue", SATURATION: "saturation", COLOR: "color", LUMINOSITY: "luminosity",
  // Canvas has no linear burn/dodge; nearest equivalents.
  LINEAR_BURN: "color-burn", LINEAR_DODGE: "lighter",
};

export function compositeOp(mode: BlendMode): GlobalCompositeOperation {
  return BLEND[mode] ?? "source-over";
}

/**
 * Fills `paths` (already in node space on `ctx`) with one paint. The gradient
 * transform maps node-normalized (0..1) space to gradient space, where a linear
 * gradient runs from (0, 0.5) to (1, 0.5) — verified on a top-to-bottom sample.
 */
export function fillWithPaint(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  size: Vec2,
  paths: { path: Path2D; rule: CanvasFillRule }[],
  images: Map<string, ImageSource>,
): void {
  if (!paint.visible || paint.opacity <= 0 || paint.type === "UNKNOWN") return;
  ctx.save();
  ctx.globalCompositeOperation = compositeOp(paint.blendMode);

  if (paint.type === "SOLID") {
    ctx.fillStyle = rgba(paint.color, paint.opacity);
    for (const p of paths) ctx.fill(p.path, p.rule);
  } else if (paint.type === "IMAGE") {
    const img = images.get(paint.imageHash);
    ctx.globalAlpha *= paint.opacity;
    if (img) {
      for (const p of paths) ctx.clip(p.path, p.rule);
      drawImageScaled(ctx, img, paint.scaleMode, size);
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.06)"; // placeholder while decoding / missing
      for (const p of paths) ctx.fill(p.path, p.rule);
    }
  } else {
    const inv = invert(paint.transform);
    const at = (x: number, y: number) => {
      const n = apply(inv, x, y);
      return { x: n.x * size.x, y: n.y * size.y };
    };
    const a = at(0, 0.5), b = at(1, 0.5), c = at(0.5, 0.5);
    let g: CanvasGradient;
    if (paint.type === "GRADIENT_LINEAR") {
      g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    } else if (paint.type === "GRADIENT_ANGULAR") {
      g = ctx.createConicGradient(Math.atan2(b.y - c.y, b.x - c.x), c.x, c.y);
    } else {
      // RADIAL (and DIAMOND, approximated as radial)
      g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, Math.hypot(b.x - c.x, b.y - c.y));
    }
    for (const s of paint.stops) g.addColorStop(Math.max(0, Math.min(1, s.position)), rgba(s.color, paint.opacity));
    ctx.fillStyle = g;
    for (const p of paths) ctx.fill(p.path, p.rule);
  }
  ctx.restore();
}

function drawImageScaled(ctx: CanvasRenderingContext2D, img: ImageSource, mode: string, size: Vec2): void {
  const { width: iw, height: ih } = img;
  if (mode === "TILE") {
    const pattern = ctx.createPattern(img, "repeat");
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, size.x, size.y);
    }
    return;
  }
  if (mode === "STRETCH") {
    ctx.drawImage(img, 0, 0, size.x, size.y);
    return;
  }
  const scale = mode === "FIT" ? Math.min(size.x / iw, size.y / ih) : Math.max(size.x / iw, size.y / ih);
  const w = iw * scale, h = ih * scale;
  ctx.drawImage(img, (size.x - w) / 2, (size.y - h) / 2, w, h);
}
