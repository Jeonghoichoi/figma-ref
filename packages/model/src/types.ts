/** "sessionID:localID" — mirrors the GUID pair used in .fig files. */
export type NodeId = string;

export interface Vec2 {
  x: number;
  y: number;
}

/** 2x3 affine matrix, same layout as .fig `Matrix`. */
export interface Transform {
  m00: number; m01: number; m02: number;
  m10: number; m11: number; m12: number;
}

export interface Color {
  r: number; g: number; b: number; a: number;
}

// Enum member names follow the .fig schema so the mapping layer stays a rename-free copy.
export type BlendMode =
  | "PASS_THROUGH" | "NORMAL"
  | "DARKEN" | "MULTIPLY" | "LINEAR_BURN" | "COLOR_BURN"
  | "LIGHTEN" | "SCREEN" | "LINEAR_DODGE" | "COLOR_DODGE"
  | "OVERLAY" | "SOFT_LIGHT" | "HARD_LIGHT"
  | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY";

export interface GradientStop {
  color: Color;
  position: number;
}

interface PaintBase {
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
  /**
   * Original decoded paint. Fields we don't model (variable bindings, authored
   * color space, thumbnails…) are carried over from here on save.
   */
  raw?: Record<string, unknown>;
}

export type Paint =
  | (PaintBase & { type: "SOLID"; color: Color })
  | (PaintBase & {
      type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
      stops: GradientStop[];
      /** Maps node-normalized space (0..1) into gradient space. */
      transform: Transform;
    })
  | (PaintBase & {
      type: "IMAGE";
      /** SHA-1 hex of the image bytes; resolves via Document.images. */
      imageHash: string;
      scaleMode: "FILL" | "FIT" | "TILE" | "STRETCH";
      transform: Transform;
    })
  /** EMOJI, VIDEO, PATTERN, NOISE… — rendered as nothing, preserved via `raw`. */
  | (PaintBase & { type: "UNKNOWN" });

export interface Effect {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "FOREGROUND_BLUR" | "BACKGROUND_BLUR" | "UNKNOWN";
  visible: boolean;
  radius: number;
  color: Color;
  offset: Vec2;
  spread: number;
  blendMode: BlendMode;
  raw?: Record<string, unknown>;
}

export type WindingRule = "NONZERO" | "ODD";

/** Flattened path commands (absolute coords in node space). */
export type PathCommand =
  | { op: "M"; x: number; y: number }
  | { op: "L"; x: number; y: number }
  | { op: "Q"; x1: number; y1: number; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "Z" };

export interface Geometry {
  windingRule: WindingRule;
  commands: PathCommand[];
  /** Index into the node's style override table (0 = node style). */
  styleID?: number;
}

export type NodeType =
  | "DOCUMENT" | "CANVAS" | "FRAME" | "GROUP" | "SECTION"
  | "RECTANGLE" | "ROUNDED_RECTANGLE" | "ELLIPSE" | "LINE" | "STAR" | "REGULAR_POLYGON"
  | "VECTOR" | "BOOLEAN_OPERATION" | "TEXT"
  | "SYMBOL" /* component */ | "INSTANCE"
  | "UNKNOWN";

export interface TextStyle {
  fontFamily: string;
  fontStyle: string;
  /** PostScript name, e.g. "NotoSansKR-Black". */
  fontPostscript: string;
  fontSize: number;
  lineHeight?: { value: number; units: "PIXELS" | "PERCENT" | "RAW" };
  letterSpacing?: { value: number; units: "PIXELS" | "PERCENT" | "RAW" };
  textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical: "TOP" | "CENTER" | "BOTTOM";
}

export interface Glyph {
  /** Outline in em units, y up. */
  commands: PathCommand[];
  /** Baseline origin in node space. */
  x: number;
  y: number;
  fontSize: number;
  /** 0 = node fills; otherwise a key of TextLayout.styleFills. */
  styleID: number;
}

export interface TextLayout {
  glyphs: Glyph[];
  /** Per-run fill overrides (mixed-color text). */
  styleFills: Record<number, Paint[]>;
}

export interface Node {
  id: NodeId;
  type: NodeType;
  name: string;
  /** null only for the DOCUMENT root. */
  parentId: NodeId | null;
  /** Fractional index string; siblings are ordered by plain string comparison. */
  position: string;

  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: BlendMode;

  transform: Transform;
  size: Vec2;

  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: "CENTER" | "INSIDE" | "OUTSIDE" | "OFFSET";
  effects: Effect[];
  cornerRadius: number;
  clipsContent: boolean;

  /** Pre-computed outline geometry (from .fig fillGeometry/strokeGeometry). */
  fillGeometry?: Geometry[];
  strokeGeometry?: Geometry[];

  text?: { characters: string; style: TextStyle };
  /**
   * Laid-out glyph outlines as computed by the authoring app. Derived and
   * read-only: never saved, and must be dropped when text or style is edited
   * (renderers fall back to live font rendering).
   */
  textLayout?: TextLayout;

  /** INSTANCE → the SYMBOL it instantiates. */
  componentId?: NodeId;

  /**
   * Original decoded NodeChange. Serialization starts from this and overlays
   * mapped fields, so fields we don't understand survive a round-trip.
   */
  raw?: Record<string, unknown>;
}

export interface Document {
  rootId: NodeId;
  nodes: Map<NodeId, Node>;
  /** imageHash (hex) → bytes */
  images: Map<string, Uint8Array>;
  /** Format-specific data needed for lossless re-encoding (schema, extra message fields, meta.json…). */
  source?: unknown;
}
