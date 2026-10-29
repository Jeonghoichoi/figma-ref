import { deflateSync, inflateSync, unzlibSync, zlibSync } from "fflate";
import { decompress as zstdDecompress } from "fzstd";

export type Compression = "zstd" | "deflate-raw" | "zlib" | "none";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function detectCompression(bytes: Uint8Array): Compression {
  if (ZSTD_MAGIC.every((b, i) => bytes[i] === b)) return "zstd";
  // zlib header: CMF=0x78 and (CMF*256 + FLG) % 31 === 0
  if (bytes.length > 1 && bytes[0] === 0x78 && ((bytes[0] << 8) | bytes[1]!) % 31 === 0) return "zlib";
  return "deflate-raw";
}

/**
 * Decompresses a chunk, auto-detecting the codec. A chunk that fails to
 * inflate is returned as-is with compression "none" so the caller can still
 * try to parse it.
 */
export function decompressChunk(bytes: Uint8Array): { data: Uint8Array; compression: Compression } {
  const detected = detectCompression(bytes);
  if (detected === "zstd") return { data: zstdDecompress(bytes), compression: "zstd" };
  if (detected === "zlib") {
    try {
      return { data: unzlibSync(bytes), compression: "zlib" };
    } catch {
      // a raw deflate stream can start with a zlib-looking header by chance
    }
  }
  try {
    return { data: inflateSync(bytes), compression: "deflate-raw" };
  } catch {
    return { data: bytes, compression: "none" };
  }
}

/**
 * zstd compression has no small pure-JS encoder, so zstd chunks are written
 * back as raw deflate. Byte-identical re-encoding of zstd files is therefore
 * not a goal; structural identity is (see docs/fig-format.md).
 */
export function compressChunk(data: Uint8Array, compression: Compression): Uint8Array {
  switch (compression) {
    case "none":
      return data;
    case "zlib":
      return zlibSync(data, { level: 9 });
    case "deflate-raw":
    case "zstd":
      return deflateSync(data, { level: 9 });
  }
}
