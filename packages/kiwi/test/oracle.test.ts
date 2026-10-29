// Cross-checks our clean-room codec against the reference kiwi implementation
// byte-for-byte. If these pass, any decode failure on a real .fig file points
// at the container/compression layer, not the codec.
import * as ref from "kiwi-schema";
import { describe, expect, it } from "vitest";
import { ByteReader, ByteWriter, decodeBinarySchema, encodeBinarySchema, KiwiCodec, printSchema } from "../src";
import { FIG_LIKE_SCHEMA_TEXT, sampleMessage } from "./sample-message";

const refSchema = ref.parseSchema(FIG_LIKE_SCHEMA_TEXT);
const refBinarySchema = ref.encodeBinarySchema(refSchema);
const refCodec = ref.compileSchema(refSchema);

describe("primitives vs reference ByteBuffer", () => {
  const floats = [0, -0, 1, -1, 0.1, 1e-30, 1e-45, 3.4e38, -123.456, Infinity, -Infinity, NaN, 2 ** -126];
  const uints = [0, 1, 127, 128, 16383, 16384, 2 ** 31, 2 ** 32 - 1];
  const ints = [0, 1, -1, 63, -64, 64, -65, 2 ** 31 - 1, -(2 ** 31)];
  const u64 = [0n, 1n, 127n, 128n, 2n ** 56n - 1n, 2n ** 56n, 2n ** 63n, 2n ** 64n - 1n];
  const i64 = [0n, -1n, 1n, -(2n ** 63n), 2n ** 63n - 1n];

  function refWrite(fn: (bb: ref.ByteBuffer) => void): Uint8Array {
    const bb = new ref.ByteBuffer();
    fn(bb);
    return bb.toUint8Array();
  }

  // Denormals (and -0) collapse to 0 by design of the float format: a zero exponent byte is written as a single 0x00.
  const asFloat32 = (v: number) => (Math.abs(v) < 2 ** -126 ? 0 : Math.fround(v));
  const identity = (v: number) => v;

  it.each([
    ["float", floats, (w: ByteWriter, v: number) => w.writeVarFloat(v), (r: ByteReader) => r.readVarFloat(), "writeVarFloat", asFloat32],
    ["uint", uints, (w: ByteWriter, v: number) => w.writeVarUint(v), (r: ByteReader) => r.readVarUint(), "writeVarUint", identity],
    ["int", ints, (w: ByteWriter, v: number) => w.writeVarInt(v), (r: ByteReader) => r.readVarInt(), "writeVarInt", identity],
  ] as const)("%s", (_name, values, write, read, refMethod, expected) => {
    for (const v of values) {
      const w = new ByteWriter();
      write(w, v);
      const ours = w.toBytes();
      const theirs = refWrite((bb) => (bb as any)[refMethod](v));
      expect(ours, `encode ${v}`).toEqual(theirs);
      expect(read(new ByteReader(ours)), `decode ${v}`).toBe(expected(v));
    }
  });

  it("uint64 / int64", () => {
    for (const v of u64) {
      const w = new ByteWriter();
      w.writeVarUint64(v);
      expect(w.toBytes()).toEqual(refWrite((bb) => bb.writeVarUint64(v)));
      expect(new ByteReader(w.toBytes()).readVarUint64()).toBe(v);
    }
    for (const v of i64) {
      const w = new ByteWriter();
      w.writeVarInt64(v);
      expect(w.toBytes()).toEqual(refWrite((bb) => bb.writeVarInt64(v)));
      expect(new ByteReader(w.toBytes()).readVarInt64()).toBe(v);
    }
  });
});

describe("binary schema", () => {
  it("decodes the reference encoding and re-encodes identically", () => {
    const schema = decodeBinarySchema(refBinarySchema);
    expect(encodeBinarySchema(schema)).toEqual(refBinarySchema);
    expect(schema.definitions.map((d) => d.name)).toEqual(refSchema.definitions.map((d) => d.name));
  });

  it("prints readable .kiwi text that the reference parser accepts", () => {
    const text = printSchema(decodeBinarySchema(refBinarySchema));
    expect(text).toContain("message NodeChange {");
    expect(text).toContain("  Paint[] fillPaints = 9;");
    expect(ref.encodeBinarySchema(ref.parseSchema(text))).toEqual(refBinarySchema);
  });
});

describe("message codec", () => {
  const codec = new KiwiCodec(decodeBinarySchema(refBinarySchema));

  it("encodes byte-identically to the reference", () => {
    const msg = sampleMessage();
    expect(codec.encode("Message", msg)).toEqual(refCodec.encodeMessage(msg));
  });

  it("decodes reference bytes and survives a round-trip", () => {
    const bytes: Uint8Array = refCodec.encodeMessage(sampleMessage());
    const decoded = codec.decode("Message", bytes);
    expect(codec.encode("Message", decoded)).toEqual(bytes);
    const node = (decoded as any).nodeChanges[2];
    expect(node.name).toBe("Frame 한글 ✓");
    expect(node.sessionTimestamp).toBe(-1234567890123n);
    expect(node.objectHash).toBe(18446744073709551615n);
    expect((decoded as any).blobs[0].bytes).toEqual(new Uint8Array([1, 2, 3, 0, 255]));
  });

  it("reports field usage while decoding", () => {
    const seen = new Set<string>();
    codec.decode("Message", codec.encode("Message", sampleMessage()), { onField: (m, f) => seen.add(`${m}.${f}`) });
    expect(seen).toContain("NodeChange.textData");
    expect(seen).toContain("TextData.characters");
  });

  it("rejects malformed input with a useful error", () => {
    expect(() => codec.decode("Message", new Uint8Array([99]))).toThrow(/unknown field id 99/);
    expect(() => codec.encode("Message", { bogus: 1 })).toThrow(/not a field of message Message/);
    expect(() => codec.encode("Message", { type: "NOPE" })).toThrow(/not a member of enum MessageType/);
  });
});
