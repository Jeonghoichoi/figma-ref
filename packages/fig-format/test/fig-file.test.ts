import * as ref from "kiwi-schema";
import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { decodeBinarySchema } from "@figref/kiwi";
import { FIG_LIKE_SCHEMA_TEXT, sampleMessage } from "../../kiwi/test/sample-message";
import {
  decodeFig,
  encodeFig,
  fromJSONValue,
  isZip,
  readRawArchive,
  readZip,
  toJSONValue,
  writeRawArchive,
  type FigFile,
} from "../src";

/** Kiwi floats are float32, so expected values must be rounded the same way. (All ints in the sample are < 2^24.) */
function fround<T>(v: T): T {
  if (typeof v === "number") return Math.fround(v) as T;
  if (Array.isArray(v)) return v.map(fround) as T;
  if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fround(x)])) as T;
  }
  return v;
}

const schema = decodeBinarySchema(ref.encodeBinarySchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT)));

function syntheticFig(overrides: Partial<FigFile> = {}): FigFile {
  return {
    magic: "fig-kiwi",
    version: 48,
    schema,
    message: sampleMessage(),
    compression: ["deflate-raw", "deflate-raw"],
    extraChunks: [],
    ...overrides,
  };
}

describe("raw archive", () => {
  it("round-trips header, version and chunks", () => {
    const archive = { magic: "fig-kiwi" as const, version: 101, chunks: [new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3])] };
    expect(readRawArchive(writeRawArchive(archive))).toEqual(archive);
  });

  it("rejects truncated or foreign data", () => {
    expect(() => readRawArchive(new TextEncoder().encode("not-a-fig-file"))).toThrow(/not a fig archive/);
    const bytes = writeRawArchive({ magic: "fig-kiwi", version: 1, chunks: [new Uint8Array(10)] });
    expect(() => readRawArchive(bytes.subarray(0, bytes.length - 1))).toThrow(/claims 10 bytes/);
  });
});

describe("fig file", () => {
  it("decodes a hand-assembled file using the reference encoder", () => {
    // Built entirely with the reference implementation + fflate, independent of our writer.
    const refCodec = ref.compileSchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT));
    const bytes = writeRawArchive({
      magic: "fig-kiwi",
      version: 48,
      chunks: [
        deflateSync(ref.encodeBinarySchema(ref.parseSchema(FIG_LIKE_SCHEMA_TEXT))),
        deflateSync(refCodec.encodeMessage(sampleMessage())),
      ],
    });
    const fig = decodeFig(bytes);
    expect(fig.version).toBe(48);
    expect(fig.compression).toEqual(["deflate-raw", "deflate-raw"]);
    expect((fig.message.nodeChanges as unknown[]).length).toBe(5);
  });

  it("raw encode → decode is structurally identical", () => {
    const fig = syntheticFig();
    const back = decodeFig(encodeFig(fig));
    expect(back.message).toEqual(fround(fig.message));
    expect(back.schema).toEqual(fig.schema);
  });

  it("ZIP wrapper keeps meta, thumbnail, images and unknown entries", () => {
    const fig = syntheticFig({
      zip: {
        meta: { file_name: "Test", client_meta: { background_color: { r: 0.9, g: 0.9, b: 0.9, a: 1 } } },
        thumbnail: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        images: new Map([["da39a3ee5e6b4b0d3255bfef95601890afd80709", new Uint8Array([9, 9])]]),
        other: new Map([["extra/notes.txt", new TextEncoder().encode("keep me")]]),
      },
    });
    const bytes = encodeFig(fig);
    expect(isZip(bytes)).toBe(true);
    const back = decodeFig(bytes);
    expect(back.message).toEqual(fround(fig.message));
    expect(back.zip).toEqual(fig.zip);
    expect(readZip(bytes).images.size).toBe(1);
  });

  it("decode → encode → decode is a fixed point (the step-7 compatibility criterion)", () => {
    const once = decodeFig(encodeFig(syntheticFig()));
    const twice = decodeFig(encodeFig(once));
    expect(twice.message).toEqual(once.message);
    expect(encodeFig(twice)).toEqual(encodeFig(once));
  });
});

describe("JSON bridge", () => {
  it("is lossless for bytes, bigints and non-finite floats", () => {
    const value = { ...sampleMessage(), weird: [NaN, Infinity, -Infinity] };
    const json = JSON.parse(JSON.stringify(toJSONValue(value)));
    expect(fromJSONValue(json)).toEqual(value);
  });
});
