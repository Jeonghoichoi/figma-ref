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

export type BlendMode =
  | "NORMAL" | "MULTIPLY" | "SCREEN" | "OVERLAY" | "DARKEN" | "LIGHTEN"
  | "COLOR_DODGE" | "COLOR_BURN" | "HARD_LIGHT" | "SOFT_LIGHT"
  | "DIFFERENCE" | "EXCLUSION" | "HUE" | "SATURATION" | "COLOR" | "LUMINOSITY"
  | "PASS_THROUGH";

export interface GradientStop {
  color: Color;
  position: number;
}

export type Paint =
  | { type: "SOLID"; color: Color; opacity: number; visible: boolean; blendMode: BlendMode }
  | {
      type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
      stops: GradientStop[];
      transform: Transform;
      opacity: number;
      visible: boolean;
      blendMode: BlendMode;
    }
  | {
      type: "IMAGE";
      /** SHA-1 hex of the image bytes; resolves via Document.images. */
      imageHash: string;
      scaleMode: "FILL" | "FIT" | "TILE" | "STRETCH";
      transform: Transform;
      opacity: number;
      visible: boolean;
      blendMode: BlendMode;
    };

export type Effect = {
  type: "DROP_SHADOW" | "INNER_SHADOW" | "LAYER_BLUR" | "BACKGROUND_BLUR";
  visible: boolean;
  radius: number;
  color?: Color;
  offset?: Vec2;
  spread?: number;
};

export type WindingRule = "NONZERO" | "EVENODD";

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
  fontSize: number;
  lineHeight?: { value: number; unit: "PIXELS" | "PERCENT" | "RAW" };
  letterSpacing?: { value: number; unit: "PIXELS" | "PERCENT" };
  textAlignHorizontal: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  textAlignVertical: "TOP" | "CENTER" | "BOTTOM";
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
  strokeAlign: "CENTER" | "INSIDE" | "OUTSIDE";
  effects: Effect[];
  cornerRadius: number;
  clipsContent: boolean;

  /** Pre-computed outline geometry (from .fig fillGeometry/strokeGeometry). */
  fillGeometry?: Geometry[];
  strokeGeometry?: Geometry[];

  text?: { characters: string; style: TextStyle };

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
