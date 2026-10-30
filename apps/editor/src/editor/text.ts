import type { TextStyle } from "@figref/model";
import { fontWeight } from "@figref/renderer";

const measureCtx = document.createElement("canvas").getContext("2d")!;

export function cssFont(style: TextStyle, scale = 1): string {
  return `${fontWeight(style.fontStyle)} ${style.fontSize * scale}px "${style.fontFamily}", sans-serif`;
}

export function lineHeightPx(style: TextStyle): number {
  if (style.lineHeight?.units === "PIXELS") return style.lineHeight.value;
  if (style.lineHeight?.units === "PERCENT") return (style.lineHeight.value / 100) * style.fontSize;
  return style.fontSize * 1.2;
}

export function letterSpacingPx(style: TextStyle): number {
  if (!style.letterSpacing) return 0;
  return style.letterSpacing.units === "PERCENT" ? (style.letterSpacing.value / 100) * style.fontSize : style.letterSpacing.value;
}

/** Box size of auto-width text in the live font (matches the renderer's fallback text drawing). */
export function measureText(text: string, style: TextStyle): { w: number; h: number } {
  measureCtx.font = cssFont(style);
  (measureCtx as any).letterSpacing = `${letterSpacingPx(style)}px`;
  const lines = text.split("\n");
  const w = Math.max(1, ...lines.map((l) => measureCtx.measureText(l).width));
  return { w, h: lines.length * lineHeightPx(style) };
}
