import { ByteReader, ByteWriter } from "./byte-buffer";

export const PRIMITIVE_TYPES = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"] as const;
export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

export const DEFINITION_KINDS = ["ENUM", "STRUCT", "MESSAGE"] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export interface Field {
  name: string;
  /** Primitive name or definition name; null for enum members. */
  type: string | null;
  isArray: boolean;
  /** Field id for MESSAGE, declaration order for STRUCT, numeric value for ENUM. */
  value: number;
  /**
   * The raw type varint from the binary schema. Enum members carry an
   * unspecified value here; keeping it lets encodeBinarySchema reproduce
   * the original bytes exactly.
   */
  rawType?: number;
}

export interface Definition {
  name: string;
  kind: DefinitionKind;
  fields: Field[];
}

export interface Schema {
  definitions: Definition[];
}

// Binary schema layout:
//   varuint definitionCount
//   per definition: string name, byte kind, varuint fieldCount
//     per field: string name, varint type (<0: ~primitiveIndex, >=0: definition index),
//                byte isArray, varuint value

export function decodeBinarySchema(bytes: Uint8Array): Schema {
  const r = new ByteReader(bytes);
  const definitionCount = r.readVarUint();
  const raw: { name: string; kind: DefinitionKind; fields: (Field & { rawType: number })[] }[] = [];

  for (let i = 0; i < definitionCount; i++) {
    const name = r.readString();
    const kindIndex = r.readByte();
    const kind = DEFINITION_KINDS[kindIndex];
    if (!kind) throw new Error(`definition ${name}: unknown kind ${kindIndex}`);
    const fieldCount = r.readVarUint();
    const fields: (Field & { rawType: number })[] = [];
    for (let j = 0; j < fieldCount; j++) {
      const fieldName = r.readString();
      const rawType = r.readVarInt();
      const isArray = (r.readByte() & 1) === 1;
      const value = r.readVarUint();
      fields.push({ name: fieldName, type: null, isArray, value, rawType });
    }
    raw.push({ name, kind, fields });
  }
  if (r.remaining !== 0) throw new Error(`binary schema has ${r.remaining} trailing bytes`);

  for (const def of raw) {
    if (def.kind === "ENUM") continue;
    for (const f of def.fields) {
      if (f.rawType < 0) {
        const prim = PRIMITIVE_TYPES[~f.rawType];
        if (!prim) throw new Error(`${def.name}.${f.name}: unknown primitive ${f.rawType}`);
        f.type = prim;
      } else {
        const target = raw[f.rawType];
        if (!target) throw new Error(`${def.name}.${f.name}: type index ${f.rawType} out of range`);
        f.type = target.name;
      }
    }
  }
  return { definitions: raw };
}

export function encodeBinarySchema(schema: Schema): Uint8Array {
  const w = new ByteWriter();
  const index = new Map(schema.definitions.map((d, i) => [d.name, i]));
  w.writeVarUint(schema.definitions.length);
  for (const def of schema.definitions) {
    w.writeString(def.name);
    w.writeByte(DEFINITION_KINDS.indexOf(def.kind));
    w.writeVarUint(def.fields.length);
    for (const f of def.fields) {
      w.writeString(f.name);
      let type: number;
      if (def.kind === "ENUM") {
        type = f.rawType ?? 0;
      } else {
        const prim = PRIMITIVE_TYPES.indexOf(f.type as PrimitiveType);
        const defIndex = f.type === null ? undefined : index.get(f.type);
        if (prim >= 0) type = ~prim;
        else if (defIndex !== undefined) type = defIndex;
        else throw new Error(`${def.name}.${f.name}: unknown type ${f.type}`);
      }
      w.writeVarInt(type);
      w.writeByte(f.isArray ? 1 : 0);
      w.writeVarUint(f.value);
    }
  }
  return w.toBytes();
}

/** Renders a schema in .kiwi text syntax — the main human-readable RE artifact. */
export function printSchema(schema: Schema): string {
  const out: string[] = [];
  for (const def of schema.definitions) {
    out.push(`${def.kind.toLowerCase()} ${def.name} {`);
    for (const f of def.fields) {
      if (def.kind === "ENUM") out.push(`  ${f.name} = ${f.value};`);
      else if (def.kind === "STRUCT") out.push(`  ${f.type}${f.isArray ? "[]" : ""} ${f.name};`);
      else out.push(`  ${f.type}${f.isArray ? "[]" : ""} ${f.name} = ${f.value};`);
    }
    out.push("}", "");
  }
  return out.join("\n");
}
