import { ByteReader, ByteWriter } from "./byte-buffer";
import type { Definition, Field, Schema } from "./schema";

// Schema-driven (interpretive) encoder/decoder. .fig files embed their own
// schema, so we never hard-code message layouts here.
//
// JS representation:
//   bool/byte/int/uint/float → boolean | number, string → string,
//   int64/uint64 → bigint, byte[] → Uint8Array,
//   enum → member name (or the raw number if the value is not in the schema),
//   struct/message → plain object (messages omit absent fields).

export type KiwiValue = unknown;

export interface DecodeOptions {
  /**
   * Called for each message field as it is decoded. Used by fig-inspect to
   * collect field-usage statistics without a second walk.
   */
  onField?: (message: string, field: string) => void;
}

interface CompiledDefinition {
  def: Definition;
  byValue: Map<number, Field>;
  byName: Map<string, Field>;
}

export class KiwiCodec {
  private defs = new Map<string, CompiledDefinition>();

  constructor(readonly schema: Schema) {
    for (const def of schema.definitions) {
      this.defs.set(def.name, {
        def,
        byValue: new Map(def.fields.map((f) => [f.value, f])),
        byName: new Map(def.fields.map((f) => [f.name, f])),
      });
    }
  }

  definition(name: string): Definition {
    return this.compiled(name).def;
  }

  private compiled(name: string): CompiledDefinition {
    const c = this.defs.get(name);
    if (!c) throw new Error(`unknown type ${name}`);
    return c;
  }

  decode(typeName: string, bytes: Uint8Array, options: DecodeOptions = {}): KiwiValue {
    const r = new ByteReader(bytes);
    const value = this.readDefinition(r, typeName, options);
    if (r.remaining !== 0) throw new Error(`${typeName}: ${r.remaining} trailing bytes`);
    return value;
  }

  encode(typeName: string, value: KiwiValue): Uint8Array {
    const w = new ByteWriter();
    this.writeDefinition(w, typeName, value, typeName);
    return w.toBytes();
  }

  private readValue(r: ByteReader, type: string, options: DecodeOptions): KiwiValue {
    switch (type) {
      case "bool": return r.readBool();
      case "byte": return r.readByte();
      case "int": return r.readVarInt();
      case "uint": return r.readVarUint();
      case "float": return r.readVarFloat();
      case "string": return r.readString();
      case "int64": return r.readVarInt64();
      case "uint64": return r.readVarUint64();
      default: return this.readDefinition(r, type, options);
    }
  }

  private readField(r: ByteReader, f: Field, options: DecodeOptions): KiwiValue {
    const type = f.type!;
    if (!f.isArray) return this.readValue(r, type, options);
    const length = r.readVarUint();
    if (type === "byte") return r.readBytes(length).slice();
    const arr = new Array(length);
    for (let i = 0; i < length; i++) arr[i] = this.readValue(r, type, options);
    return arr;
  }

  private readDefinition(r: ByteReader, name: string, options: DecodeOptions): KiwiValue {
    const { def, byValue } = this.compiled(name);
    switch (def.kind) {
      case "ENUM": {
        const v = r.readVarUint();
        return byValue.get(v)?.name ?? v;
      }
      case "STRUCT": {
        const obj: Record<string, KiwiValue> = {};
        for (const f of def.fields) obj[f.name] = this.readField(r, f, options);
        return obj;
      }
      case "MESSAGE": {
        const obj: Record<string, KiwiValue> = {};
        const start = r.offset;
        for (;;) {
          const id = r.readVarUint();
          if (id === 0) return obj;
          const f = byValue.get(id);
          if (!f) throw new Error(`${name}: unknown field id ${id} (message starts at byte ${start})`);
          options.onField?.(name, f.name);
          obj[f.name] = this.readField(r, f, options);
        }
      }
    }
  }

  private writeValue(w: ByteWriter, type: string, v: KiwiValue, path: string): void {
    switch (type) {
      case "bool": w.writeBool(expect(v, "boolean", path)); return;
      case "byte": w.writeByte(expect(v, "number", path)); return;
      case "int": w.writeVarInt(expect(v, "number", path)); return;
      case "uint": w.writeVarUint(expect(v, "number", path)); return;
      case "float": w.writeVarFloat(expect(v, "number", path)); return;
      case "string": w.writeString(expect(v, "string", path)); return;
      case "int64": w.writeVarInt64(BigInt(expect(v, ["bigint", "number"], path))); return;
      case "uint64": w.writeVarUint64(BigInt(expect(v, ["bigint", "number"], path))); return;
      default: this.writeDefinition(w, type, v, path);
    }
  }

  private writeField(w: ByteWriter, f: Field, v: KiwiValue, path: string): void {
    const type = f.type!;
    if (!f.isArray) return this.writeValue(w, type, v, path);
    if (type === "byte" && v instanceof Uint8Array) {
      w.writeVarUint(v.length);
      w.writeBytes(v);
      return;
    }
    if (!Array.isArray(v)) throw new TypeError(`${path}: expected array`);
    w.writeVarUint(v.length);
    v.forEach((item, i) => this.writeValue(w, type, item, `${path}[${i}]`));
  }

  private writeDefinition(w: ByteWriter, name: string, v: KiwiValue, path: string): void {
    const { def, byName } = this.compiled(name);
    switch (def.kind) {
      case "ENUM": {
        if (typeof v === "number") return w.writeVarUint(v);
        const f = typeof v === "string" ? byName.get(v) : undefined;
        if (!f) throw new TypeError(`${path}: ${JSON.stringify(v)} is not a member of enum ${name}`);
        return w.writeVarUint(f.value);
      }
      case "STRUCT": {
        const obj = expectObject(v, path);
        for (const f of def.fields) {
          if (!(f.name in obj)) throw new TypeError(`${path}.${f.name}: missing struct field`);
          this.writeField(w, f, obj[f.name], `${path}.${f.name}`);
        }
        return;
      }
      case "MESSAGE": {
        const obj = expectObject(v, path);
        for (const key of Object.keys(obj)) {
          if (!byName.has(key)) throw new TypeError(`${path}.${key}: not a field of message ${name}`);
        }
        // Fields are written in schema order, matching the reference encoder.
        for (const f of def.fields) {
          const fv = obj[f.name];
          if (fv === undefined) continue;
          w.writeVarUint(f.value);
          this.writeField(w, f, fv, `${path}.${f.name}`);
        }
        w.writeVarUint(0);
      }
    }
  }
}

function expect<T>(v: unknown, type: string | string[], path: string): T {
  const types = Array.isArray(type) ? type : [type];
  if (!types.includes(typeof v)) throw new TypeError(`${path}: expected ${types.join("|")}, got ${typeof v}`);
  return v as T;
}

function expectObject(v: unknown, path: string): Record<string, KiwiValue> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError(`${path}: expected object`);
  return v as Record<string, KiwiValue>;
}
