import { IDENTITY, type BlendMode, type Color, type Effect, type Paint } from "@figref/model";
import { deepEqual } from "./equal";

type Raw = Record<string, any>;

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const GRADIENTS = new Set(["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"]);
const EFFECTS = new Set(["DROP_SHADOW", "INNER_SHADOW", "FOREGROUND_BLUR", "BACKGROUND_BLUR"]);

export function hex(bytes: Uint8Array | undefined): string {
  return bytes ? Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("") : "";
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function decodePaint(raw: Raw): Paint {
  const base = {
    opacity: raw.opacity ?? 1,
    visible: raw.visible ?? true,
    blendMode: (raw.blendMode ?? "NORMAL") as BlendMode,
    raw,
  };
  if (raw.type === "SOLID") return { ...base, type: "SOLID", color: raw.color ?? BLACK };
  if (GRADIENTS.has(raw.type)) {
    return { ...base, type: raw.type, stops: raw.stops ?? [], transform: raw.transform ?? IDENTITY };
  }
  if (raw.type === "IMAGE") {
    return {
      ...base,
      type: "IMAGE",
      imageHash: hex(raw.image?.hash),
      scaleMode: raw.imageScaleMode ?? "FILL",
      transform: raw.transform ?? IDENTITY,
    };
  }
  return { ...base, type: "UNKNOWN" };
}

/**
 * Builds the raw paint to save. Unchanged paints are returned as their original
 * object; for changed ones, fields derived from what changed (variable bindings,
 * authored color, thumbnails) are dropped so they can't contradict the new value.
 */
export function encodePaint(p: Paint): Raw {
  const before = p.raw ? decodePaint(p.raw) : undefined;
  if (before && deepEqual({ ...before, raw: undefined }, { ...p, raw: undefined })) return p.raw!;

  // Switching paint type: start clean rather than inherit the other type's fields.
  const out: Raw = before && before.type === p.type ? { ...p.raw } : {};
  const changed = (k: string) => !before || before.type !== p.type || !deepEqual((before as any)[k], (p as any)[k]);

  if (p.type !== "UNKNOWN") out.type = p.type;
  out.opacity = p.opacity;
  out.visible = p.visible;
  out.blendMode = p.blendMode;
  if (changed("opacity")) delete out.opacityVar;

  switch (p.type) {
    case "SOLID":
      out.color = p.color;
      if (changed("color")) {
        delete out.colorVar;
        delete out.authoredColor;
      }
      break;
    case "GRADIENT_LINEAR":
    case "GRADIENT_RADIAL":
    case "GRADIENT_ANGULAR":
    case "GRADIENT_DIAMOND":
      out.stops = p.stops;
      out.transform = p.transform;
      if (changed("stops")) {
        delete out.stopsVar;
        delete out.authoredStops;
        delete out.gradientVar;
      }
      break;
    case "IMAGE":
      out.imageScaleMode = p.scaleMode;
      out.transform = p.transform;
      if (changed("imageHash")) {
        out.image = { hash: unhex(p.imageHash) };
        for (const k of ["imageThumbnail", "thumbHash", "thumbHashBase64", "originalImageWidth", "originalImageHeight", "imageVar"]) delete out[k];
      }
      break;
  }
  return out;
}

export function decodeEffect(raw: Raw): Effect {
  return {
    type: EFFECTS.has(raw.type) ? raw.type : "UNKNOWN",
    visible: raw.visible ?? true,
    radius: raw.radius ?? 0,
    color: raw.color ?? BLACK,
    offset: raw.offset ?? { x: 0, y: 0 },
    spread: raw.spread ?? 0,
    blendMode: raw.blendMode ?? "NORMAL",
    raw,
  };
}

export function encodeEffect(e: Effect): Raw {
  const before = e.raw ? decodeEffect(e.raw) : undefined;
  if (before && deepEqual({ ...before, raw: undefined }, { ...e, raw: undefined })) return e.raw!;

  const out: Raw = before && before.type === e.type ? { ...e.raw } : {};
  const changed = (k: keyof Effect) => !before || before.type !== e.type || !deepEqual(before[k], e[k]);

  if (e.type !== "UNKNOWN") out.type = e.type;
  Object.assign(out, { visible: e.visible, radius: e.radius, color: e.color, offset: e.offset, spread: e.spread, blendMode: e.blendMode });
  if (changed("radius")) delete out.radiusVar;
  if (changed("spread")) delete out.spreadVar;
  if (changed("color")) {
    delete out.colorVar;
    delete out.authoredColor;
  }
  if (changed("offset")) {
    delete out.xVar;
    delete out.yVar;
  }
  return out;
}
