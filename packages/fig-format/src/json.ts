// Lossless JSON bridge for decoded Kiwi values, so dumps can be diffed,
// hand-edited and re-encoded:
//   Uint8Array → { "$bytes": "<base64>" }   (or { "$bytes": n } when elided)
//   bigint     → { "$bigint": "123" }
//   NaN/±Inf   → { "$float": "NaN" | "Infinity" | "-Infinity" }

export interface ToJSONOptions {
  /** Replace byte arrays longer than this with their length (dump readability). Default: keep all. */
  maxBytes?: number;
}

export function toJSONValue(v: unknown, options: ToJSONOptions = {}): unknown {
  if (v instanceof Uint8Array) {
    if (options.maxBytes !== undefined && v.length > options.maxBytes) return { $bytes: v.length };
    return { $bytes: toBase64(v) };
  }
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (typeof v === "number" && !Number.isFinite(v)) return { $float: String(v) };
  if (Array.isArray(v)) return v.map((x) => toJSONValue(x, options));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJSONValue(x, options);
    return out;
  }
  return v;
}

export function fromJSONValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJSONValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1) {
      if (typeof o.$bytes === "string") return fromBase64(o.$bytes);
      if (typeof o.$bytes === "number") throw new Error("cannot restore elided byte array");
      if (typeof o.$bigint === "string") return BigInt(o.$bigint);
      if (typeof o.$float === "string") return Number(o.$float);
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = fromJSONValue(x);
    return out;
  }
  return v;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
