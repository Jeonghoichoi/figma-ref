import { decodeBinarySchema, encodeBinarySchema, KiwiCodec, type DecodeOptions, type Schema } from "@figref/kiwi";
import { compressChunk, decompressChunk, type Compression } from "./compression";
import {
  isZip,
  readRawArchive,
  readZip,
  writeRawArchive,
  writeZip,
  type RawMagic,
  type ZipEntries,
} from "./container";

export const ROOT_TYPE = "Message";

/** A fully decoded .fig file, before mapping into @figref/model. */
export interface FigFile {
  magic: RawMagic;
  version: number;
  schema: Schema;
  /** Decoded root message (type "Message"). */
  message: Record<string, unknown>;
  /** Compression used per chunk in the source file — informational, reused on write. */
  compression: Compression[];
  /** Chunks after the message chunk, preserved verbatim. */
  extraChunks: Uint8Array[];
  /** Present when the source was a ZIP. */
  zip?: Omit<ZipEntries, "canvas">;
}

export function decodeFig(bytes: Uint8Array, options: DecodeOptions = {}): FigFile {
  let zip: FigFile["zip"];
  let canvas = bytes;
  if (isZip(bytes)) {
    const { canvas: c, ...rest } = readZip(bytes);
    canvas = c;
    zip = rest;
  }

  const archive = readRawArchive(canvas);
  const [schemaChunk, messageChunk, ...extraChunks] = archive.chunks;
  if (!schemaChunk || !messageChunk) {
    throw new Error(`expected at least 2 chunks (schema, message), got ${archive.chunks.length}`);
  }

  const schemaData = decompressChunk(schemaChunk);
  const messageData = decompressChunk(messageChunk);
  const schema = decodeBinarySchema(schemaData.data);
  const codec = new KiwiCodec(schema);
  const message = codec.decode(ROOT_TYPE, messageData.data, options) as Record<string, unknown>;

  return {
    magic: archive.magic,
    version: archive.version,
    schema,
    message,
    compression: [schemaData.compression, messageData.compression],
    extraChunks: extraChunks.map((c) => c.slice()),
    zip,
  };
}

export function encodeFig(fig: FigFile): Uint8Array {
  const codec = new KiwiCodec(fig.schema);
  const schemaBytes = encodeBinarySchema(fig.schema);
  const messageBytes = codec.encode(ROOT_TYPE, fig.message);
  const canvas = writeRawArchive({
    magic: fig.magic,
    version: fig.version,
    chunks: [
      compressChunk(schemaBytes, fig.compression[0] ?? "deflate-raw"),
      compressChunk(messageBytes, fig.compression[1] ?? "deflate-raw"),
      ...fig.extraChunks,
    ],
  });
  return fig.zip ? writeZip({ canvas, ...fig.zip }) : canvas;
}
