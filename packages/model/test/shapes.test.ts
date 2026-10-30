import { describe, expect, it } from "vitest";
import { ellipsePath, rectPath, starPath } from "../src";

describe("shape geometry", () => {
  it("star matches a stored 5-point star (389×393, innerScale 0.382) from a real file", () => {
    // Vertices decoded from the sample's fillGeometry blob (docs/fig-format.md).
    const stored = [
      [194.5, 0], [238.168, 135.778], [379.48, 135.778], [265.156, 219.694], [308.824, 355.472],
      [194.5, 271.556], [80.176, 355.472], [123.844, 219.694], [9.52, 135.778], [150.832, 135.778], [194.5, 0],
    ];
    const ours = starPath(389, 393, 5, 0.3819660246372223).filter((c) => c.op !== "Z") as { x: number; y: number }[];
    expect(ours).toHaveLength(stored.length);
    ours.forEach((p, i) => {
      expect(p.x).toBeCloseTo(stored[i]![0]!, 2);
      expect(p.y).toBeCloseTo(stored[i]![1]!, 2);
    });
  });

  it("ellipse matches a stored 120×120 circle", () => {
    // Stored: M120,60 C120,93.1,93.1,120,60,120 …
    const [m, c] = ellipsePath(120, 120) as any[];
    expect([m.x, m.y]).toEqual([120, 60]);
    expect([c.x1, c.y1, c.x2, c.y2, c.x, c.y].map((v: number) => +v.toFixed(1))).toEqual([120, 93.1, 93.1, 120, 60, 120]);
  });

  it("sharp rect uses the stored command sequence; rounded rect clamps the radius", () => {
    expect(rectPath(588, 280).map((c) => c.op).join("")).toBe("MLLLLZ");
    const rounded = rectPath(10, 4, 100);
    expect(rounded[0]).toEqual({ op: "M", x: 2, y: 0 });
  });
});
