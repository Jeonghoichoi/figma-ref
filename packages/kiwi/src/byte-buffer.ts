// Kiwi wire primitives. All multi-byte scalars are variable-length:
//   uint   LEB128, max 5 bytes
//   int    zigzag(uint)
//   float  32-bit IEEE with bits rotated left by 9 so the exponent lands in the
//          low byte; an all-zero exponent (0.0 / denormals) is written as one 0x00 byte
//   string UTF-8, NUL-terminated
//   int64/uint64  LEB128 BigInt, max 9 bytes (last byte carries a full 8 bits)

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);
const utf8Decoder = new TextDecoder();
const utf8Encoder = new TextEncoder();

export class ByteReader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.data.length) throw new RangeError(`read past end at ${this.offset}`);
    return this.data[this.offset++]!;
  }

  readBool(): boolean {
    const v = this.readByte();
    if (v > 1) throw new Error(`invalid bool ${v} at ${this.offset - 1}`);
    return v === 1;
  }

  readBytes(n: number): Uint8Array {
    if (this.offset + n > this.data.length) throw new RangeError(`read ${n} bytes past end at ${this.offset}`);
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  readVarUint(): number {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readByte();
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80 && shift < 35);
    return value >>> 0;
  }

  readVarInt(): number {
    const v = this.readVarUint() | 0;
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }

  readVarFloat(): number {
    const first = this.readByte();
    if (first === 0) return 0;
    const b = this.readBytes(3);
    let bits = first | (b[0]! << 8) | (b[1]! << 16) | (b[2]! << 24);
    bits = (bits << 23) | (bits >>> 9);
    i32[0] = bits;
    return f32[0]!;
  }

  readString(): string {
    const start = this.offset;
    const end = this.data.indexOf(0, start);
    if (end < 0) throw new RangeError(`unterminated string at ${start}`);
    this.offset = end + 1;
    return utf8Decoder.decode(this.data.subarray(start, end));
  }

  readVarUint64(): bigint {
    let value = 0n;
    let shift = 0n;
    let byte: number;
    while ((byte = this.readByte()) & 0x80 && shift < 56n) {
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    }
    return value | (BigInt(byte) << shift);
  }

  readVarInt64(): bigint {
    const v = this.readVarUint64();
    const half = v >> 1n;
    return v & 1n ? ~half : half;
  }
}

export class ByteWriter {
  private buf = new Uint8Array(256);
  length = 0;

  private reserve(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }

  writeByte(v: number): void {
    this.reserve(1);
    this.buf[this.length++] = v & 0xff;
  }

  writeBool(v: boolean): void {
    this.writeByte(v ? 1 : 0);
  }

  writeBytes(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }

  writeVarUint(v: number): void {
    v >>>= 0;
    do {
      const byte = v & 0x7f;
      v >>>= 7;
      this.writeByte(v ? byte | 0x80 : byte);
    } while (v);
  }

  writeVarInt(v: number): void {
    this.writeVarUint((v << 1) ^ (v >> 31));
  }

  writeVarFloat(v: number): void {
    f32[0] = v;
    let bits = i32[0]!;
    bits = (bits >>> 23) | (bits << 9);
    if ((bits & 0xff) === 0) {
      this.writeByte(0);
      return;
    }
    this.reserve(4);
    this.buf[this.length++] = bits;
    this.buf[this.length++] = bits >>> 8;
    this.buf[this.length++] = bits >>> 16;
    this.buf[this.length++] = bits >>> 24;
  }

  writeString(s: string): void {
    const bytes = utf8Encoder.encode(s);
    if (bytes.includes(0)) throw new Error("kiwi strings cannot contain NUL");
    this.writeBytes(bytes);
    this.writeByte(0);
  }

  writeVarUint64(v: bigint): void {
    if (v < 0n || v >= 1n << 64n) throw new RangeError(`uint64 out of range: ${v}`);
    for (let i = 0; v > 0x7fn && i < 8; i++) {
      this.writeByte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.writeByte(Number(v));
  }

  writeVarInt64(v: bigint): void {
    if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError(`int64 out of range: ${v}`);
    this.writeVarUint64(v < 0n ? ~(v << 1n) & ((1n << 64n) - 1n) : v << 1n);
  }
}
