import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";

// Two container layers:
//   1. Optional ZIP wrapper (canvas.fig + meta.json + thumbnail.png + images/*)
//   2. Raw "fig-kiwi" archive: 8-byte magic, uint32 LE version, then
//      repeated [uint32 LE length][bytes] chunks.

export const RAW_MAGICS = ["fig-kiwi", "fig-jam."] as const;
export type RawMagic = (typeof RAW_MAGICS)[number];

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const CANVAS_ENTRY = "canvas.fig";

export interface RawArchive {
  magic: RawMagic;
  version: number;
  chunks: Uint8Array[];
}

export interface ZipEntries {
  canvas: Uint8Array;
  meta?: unknown;
  thumbnail?: Uint8Array;
  /** "images/<hash>" entries keyed by hash */
  images: Map<string, Uint8Array>;
  /** Anything else in the archive, preserved verbatim. */
  other: Map<string, Uint8Array>;
}

export function isZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

export function readZip(bytes: Uint8Array): ZipEntries {
  const files = unzipSync(bytes);
  const canvas = files[CANVAS_ENTRY];
  if (!canvas) throw new Error(`ZIP has no ${CANVAS_ENTRY} (entries: ${Object.keys(files).join(", ")})`);
  const out: ZipEntries = { canvas, images: new Map(), other: new Map() };
  for (const [name, data] of Object.entries(files)) {
    if (name === CANVAS_ENTRY) continue;
    if (name === "meta.json") out.meta = JSON.parse(strFromU8(data));
    else if (name === "thumbnail.png") out.thumbnail = data;
    else if (name.startsWith("images/") && name.length > "images/".length) out.images.set(name.slice(7), data);
    else if (!name.endsWith("/")) out.other.set(name, data);
  }
  return out;
}

export function writeZip(entries: ZipEntries): Uint8Array {
  // Already-compressed payloads are stored (level 0) like the original archives.
  const files: Zippable = { [CANVAS_ENTRY]: [entries.canvas, { level: 0 }] };
  if (entries.meta !== undefined) files["meta.json"] = strToU8(JSON.stringify(entries.meta));
  if (entries.thumbnail) files["thumbnail.png"] = [entries.thumbnail, { level: 0 }];
  for (const [hash, data] of entries.images) files[`images/${hash}`] = [data, { level: 0 }];
  for (const [name, data] of entries.other) files[name] = data;
  return zipSync(files);
}

export function readRawArchive(bytes: Uint8Array): RawArchive {
  const magic = new TextDecoder().decode(bytes.subarray(0, 8)) as RawMagic;
  if (!RAW_MAGICS.includes(magic)) {
    throw new Error(`not a fig archive: header ${JSON.stringify(magic)}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  let offset = 12;
  while (offset + 4 <= bytes.length) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > bytes.length) {
      throw new Error(`chunk ${chunks.length} claims ${length} bytes at ${offset - 4}, only ${bytes.length - offset} left`);
    }
    chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.length) throw new Error(`${bytes.length - offset} trailing bytes after last chunk`);
  return { magic, version, chunks };
}

export function writeRawArchive(archive: RawArchive): Uint8Array {
  const size = 12 + archive.chunks.reduce((n, c) => n + 4 + c.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(archive.magic), 0);
  view.setUint32(8, archive.version, true);
  let offset = 12;
  for (const chunk of archive.chunks) {
    view.setUint32(offset, chunk.length, true);
    out.set(chunk, offset + 4);
    offset += 4 + chunk.length;
  }
  return out;
}
