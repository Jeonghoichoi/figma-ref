import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIG_LIKE_SCHEMA_TEXT = readFileSync(fileURLToPath(new URL("./fixtures/fig-like.kiwi", import.meta.url)), "utf8");

/** A small document: root → page → frame → (rect, text). */
export function sampleMessage(): Record<string, unknown> {
  const guid = (localID: number) => ({ sessionID: 0, localID });
  return {
    type: "NODE_CHANGES",
    sessionID: 0,
    ackID: 0,
    nodeChanges: [
      { guid: guid(0), type: "DOCUMENT", name: "Document", visible: true, opacity: 1 },
      { guid: guid(1), parentIndex: { guid: guid(0), position: "!" }, type: "CANVAS", name: "Page 1" },
      {
        guid: guid(2),
        parentIndex: { guid: guid(1), position: "P" },
        type: "FRAME",
        name: "Frame 한글 ✓",
        size: { x: 375, y: 812 },
        transform: { m00: 1, m01: 0, m02: 100.5, m10: 0, m11: 1, m12: -20.25 },
        fillPaints: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
        sessionTimestamp: -1234567890123n,
        objectHash: 18446744073709551615n,
      },
      {
        guid: guid(3),
        parentIndex: { guid: guid(2), position: "P" },
        type: "RECTANGLE",
        name: "Rect",
        size: { x: 0.1, y: 1e-30 },
        cornerRadiusDelta: -7,
        fillPaints: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.6, a: 0.5 }, opacity: 0.75, visible: false }],
      },
      {
        guid: guid(4),
        parentIndex: { guid: guid(2), position: "Q" },
        type: "TEXT",
        name: "Label",
        textData: {
          characters: "Hello\nWorld 🌍",
          lines: [0, 1].map(() => ({ lineType: "PLAIN", styleId: 0, indentationLevel: 0, sourceDirectionality: "AUTO", listStartOffset: 0, isFirstLineOfList: false })),
        },
      },
    ],
    blobs: [{ bytes: new Uint8Array([1, 2, 3, 0, 255]) }, { bytes: new Uint8Array() }],
  };
}
