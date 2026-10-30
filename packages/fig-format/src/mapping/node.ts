import { IDENTITY, type Geometry, type Node, type NodeId, type NodeType, type TextStyle } from "@figref/model";
import { deepEqual } from "./equal";
import { decodeEffect, decodePaint, encodeEffect, encodePaint } from "./paint";
import { decodePathBlob, encodePathBlob } from "./path";

// NodeChange ⇄ Node, field by field.
//
// Saving starts from the node's original NodeChange (`node.raw`) and rewrites
// a field only when the model value differs from what that field decodes to.
// Untouched nodes therefore re-encode to exactly their original message, and
// fields we don't model survive edits to the ones we do.

type Raw = Record<string, any>;
type Guid = { sessionID: number; localID: number };

export interface BlobTable {
  blobs: { bytes: Uint8Array }[];
}

const KNOWN_TYPES = new Set<NodeType>([
  "DOCUMENT", "CANVAS", "FRAME", "GROUP", "SECTION",
  "RECTANGLE", "ROUNDED_RECTANGLE", "ELLIPSE", "LINE", "STAR", "REGULAR_POLYGON",
  "VECTOR", "BOOLEAN_OPERATION", "TEXT", "SYMBOL", "INSTANCE",
]);
const FRAME_LIKE = new Set(["FRAME", "SYMBOL", "INSTANCE", "SECTION"]);

/** Template for TextData.lines entries, copied from real files (one entry per paragraph). */
const PLAIN_LINE = {
  lineType: "PLAIN", styleId: 0, indentationLevel: 0, sourceDirectionality: "AUTO", listStartOffset: 0, isFirstLineOfList: false,
};
/** Text layout results that go stale when characters or style change. */
const TEXT_LAYOUT_KEYS = [
  "layoutSize", "baselines", "glyphs", "decorations", "fontMetaData", "logicalIndexToCharacterOffsetMap",
  "derivedLines", "truncationStartIndex", "truncatedHeight", "minContentHeight", "hyperlinkBoxes", "mentionBoxes",
];

export function guidToId(g: Guid): NodeId {
  return `${g.sessionID}:${g.localID}`;
}

export function idToGuid(id: NodeId): Guid {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) throw new Error(`node id ${JSON.stringify(id)} is not "sessionID:localID"`);
  return { sessionID: Number(m[1]), localID: Number(m[2]) };
}

/**
 * Groups are not stored as GROUP: real files use a FRAME with resizeToFit and
 * no fills (docs/fig-format.md). Map that shape back to GROUP.
 */
function readType(raw: Raw): NodeType {
  if (raw.type === "FRAME" && raw.resizeToFit === true && !(raw.fillPaints?.length)) return "GROUP";
  return KNOWN_TYPES.has(raw.type) ? raw.type : "UNKNOWN";
}

function readGeometry(paths: Raw[] | undefined, t: BlobTable): Geometry[] | undefined {
  return paths?.map((p) => {
    const blob = t.blobs[p.commandsBlob];
    if (!blob) throw new Error(`geometry references missing blob ${p.commandsBlob}`);
    const g: Geometry = { windingRule: p.windingRule ?? "NONZERO", commands: decodePathBlob(blob.bytes) };
    if (p.styleID !== undefined) g.styleID = p.styleID;
    return g;
  });
}

function writeGeometry(value: Geometry[] | undefined, rawPaths: Raw[] | undefined, t: BlobTable): Raw[] | undefined {
  if (!value) return undefined;
  const before = readGeometry(rawPaths, t) ?? [];
  return value.map((g, i) => {
    if (rawPaths?.[i] && deepEqual(before[i], g)) return rawPaths[i]!;
    t.blobs.push({ bytes: encodePathBlob(g.commands) });
    const p: Raw = { windingRule: g.windingRule, commandsBlob: t.blobs.length - 1 };
    if (g.styleID !== undefined) p.styleID = g.styleID;
    return p;
  });
}

function readText(raw: Raw): Node["text"] {
  if (raw.type !== "TEXT") return undefined;
  const style: TextStyle = {
    fontFamily: raw.fontName?.family ?? "",
    fontStyle: raw.fontName?.style ?? "",
    fontPostscript: raw.fontName?.postscript ?? "",
    fontSize: raw.fontSize ?? 12,
    textAlignHorizontal: raw.textAlignHorizontal ?? "LEFT",
    textAlignVertical: raw.textAlignVertical ?? "TOP",
  };
  if (raw.lineHeight) style.lineHeight = raw.lineHeight;
  if (raw.letterSpacing) style.letterSpacing = raw.letterSpacing;
  return { characters: raw.textData?.characters ?? "", style };
}

function writeText(value: Node["text"], out: Raw, raw: Raw): void {
  if (!value) return;
  const before = readText(raw);
  const { characters, style } = value;

  if (!before || before.characters !== characters) {
    const td: Raw = { ...raw.textData, characters };
    for (const k of TEXT_LAYOUT_KEYS) delete td[k];
    const length = [...characters].length;
    const ids: number[] | undefined = td.characterStyleIDs;
    if (ids && ids.length !== length) {
      // A uniform style can be stretched to the new length; mixed styling can't be re-aligned without a diff.
      if (ids.every((x) => x === ids[0])) td.characterStyleIDs = new Array(length).fill(ids[0]);
      else delete td.characterStyleIDs;
    }
    const paragraphs = characters.split("\n").length;
    const lines: Raw[] = td.lines ?? [];
    td.lines = Array.from({ length: paragraphs }, (_, i) => lines[i] ?? lines.at(-1) ?? PLAIN_LINE);
    out.textData = td;
  }

  if (!before || !deepEqual(before.style, style)) {
    out.fontName = { family: style.fontFamily, style: style.fontStyle, postscript: style.fontPostscript };
    out.fontSize = style.fontSize;
    out.textAlignHorizontal = style.textAlignHorizontal;
    out.textAlignVertical = style.textAlignVertical;
    if (style.lineHeight) out.lineHeight = style.lineHeight;
    else delete out.lineHeight;
    if (style.letterSpacing) {
      out.letterSpacing = style.letterSpacing;
      // textTracking mirrors letterSpacing in PERCENT (5% ↔ 0.05) in real files.
      if (style.letterSpacing.units === "PERCENT") out.textTracking = style.letterSpacing.value / 100;
      else delete out.textTracking;
    } else {
      delete out.letterSpacing;
      delete out.textTracking;
    }
  }

  if (!before || !deepEqual(before, value)) delete out.derivedTextData;
}

interface FieldMapping<K extends keyof Node> {
  key: K;
  read(raw: Raw, t: BlobTable): Node[K];
  write(value: Node[K], out: Raw, raw: Raw, t: BlobTable): void;
}

function field<K extends keyof Node>(
  key: K,
  read: FieldMapping<K>["read"],
  write: FieldMapping<K>["write"],
): FieldMapping<K> {
  return { key, read, write };
}

/** A field stored under the same name with a default for "absent". */
function plain<K extends keyof Node>(key: K, rawKey: string, fallback: Node[K]): FieldMapping<K> {
  return field(key, (raw) => raw[rawKey] ?? fallback, (v, out) => (out[rawKey] = v));
}

const MAPPINGS: FieldMapping<any>[] = [
  field("type", readType, (v: NodeType, out, raw) => {
    if (v === "UNKNOWN") return;
    if (v === "GROUP") {
      out.type = "FRAME";
      out.resizeToFit = true;
      return;
    }
    out.type = v;
    if (raw.type === "FRAME" && v === "FRAME") delete out.resizeToFit; // group → frame
  }),
  plain("name", "name", ""),
  plain("visible", "visible", true),
  plain("locked", "locked", false),
  plain("opacity", "opacity", 1),
  plain("blendMode", "blendMode", "PASS_THROUGH"),
  plain("transform", "transform", IDENTITY),
  plain("size", "size", { x: 0, y: 0 }),
  field("fills", (raw) => (raw.fillPaints ?? []).map(decodePaint), (v, out) => (out.fillPaints = v.map(encodePaint))),
  field("strokes", (raw) => (raw.strokePaints ?? []).map(decodePaint), (v, out) => (out.strokePaints = v.map(encodePaint))),
  plain("strokeWeight", "strokeWeight", 0),
  plain("strokeAlign", "strokeAlign", "CENTER"),
  field("effects", (raw) => (raw.effects ?? []).map(decodeEffect), (v, out) => (out.effects = v.map(encodeEffect))),
  field(
    "cornerRadius",
    (raw) => raw.cornerRadius ?? 0,
    (v, out, raw) => {
      out.cornerRadius = v;
      if (!raw.rectangleCornerRadiiIndependent) {
        for (const k of ["rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomLeftCornerRadius", "rectangleBottomRightCornerRadius"]) {
          if (k in raw) out[k] = v;
        }
      }
    },
  ),
  // Absent bool = false, i.e. frames clip unless frameMaskDisabled is set.
  field(
    "clipsContent",
    (raw) => FRAME_LIKE.has(raw.type) && readType(raw) !== "GROUP" && raw.frameMaskDisabled !== true,
    (v, out) => {
      if (FRAME_LIKE.has(out.type)) out.frameMaskDisabled = !v;
    },
  ),
  field("fillGeometry", (raw, t) => readGeometry(raw.fillGeometry, t), (v, out, raw, t) => {
    const g = writeGeometry(v, raw.fillGeometry, t);
    if (g) out.fillGeometry = g;
    else delete out.fillGeometry;
  }),
  field("strokeGeometry", (raw, t) => readGeometry(raw.strokeGeometry, t), (v, out, raw, t) => {
    const g = writeGeometry(v, raw.strokeGeometry, t);
    if (g) out.strokeGeometry = g;
    else delete out.strokeGeometry;
  }),
  field("text", readText, (v, out, raw) => writeText(v, out, raw)),
  field(
    "componentId",
    (raw) => (raw.symbolData?.symbolID ? guidToId(raw.symbolData.symbolID) : undefined),
    (v, out, raw) => {
      if (v) out.symbolData = { ...raw.symbolData, symbolID: idToGuid(v) };
      else delete out.symbolData;
    },
  ),
];

export function decodeNode(raw: Raw, t: BlobTable): Node {
  if (!raw.guid) throw new Error("NodeChange without guid");
  const node: Record<string, unknown> = {
    id: guidToId(raw.guid),
    parentId: raw.parentIndex ? guidToId(raw.parentIndex.guid) : null,
    position: raw.parentIndex?.position ?? "",
    raw,
  };
  for (const m of MAPPINGS) {
    const v = m.read(raw, t);
    if (v !== undefined) node[m.key] = v;
  }
  return node as unknown as Node;
}

export function encodeNode(node: Node, t: BlobTable): Raw {
  const raw: Raw = node.raw ?? {};
  const isNew = !node.raw;
  const out: Raw = { ...raw, guid: idToGuid(node.id) };
  if (isNew) out.phase = "CREATED";

  if (node.parentId === null) {
    delete out.parentIndex;
  } else {
    const guid = idToGuid(node.parentId);
    if (isNew || !raw.parentIndex || guidToId(raw.parentIndex.guid) !== node.parentId || raw.parentIndex.position !== node.position) {
      out.parentIndex = { ...raw.parentIndex, guid, position: node.position };
    }
  }

  for (const m of MAPPINGS) {
    const value = (node as any)[m.key];
    if (isNew ? value !== undefined : !deepEqual(m.read(raw, t), value)) m.write(value, out, raw, t);
  }
  return out;
}
