import type { PathCommand } from "@figref/model";

// Geometry blob layout (verified on real files, see docs/fig-format.md):
//   repeated [cmd u8][float32 LE × argc]
//   0 close · 1 moveTo(x,y) · 2 lineTo(x,y) · 3 quadTo(x1,y1,x,y) · 4 cubicTo(x1,y1,x2,y2,x,y)

const OPS = ["Z", "M", "L", "Q", "C"] as const;
const ARGC = [0, 2, 2, 4, 6];

export function decodePathBlob(bytes: Uint8Array): PathCommand[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PathCommand[] = [];
  let o = 0;
  const f = () => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  while (o < bytes.length) {
    const cmd = bytes[o]!;
    const argc = ARGC[cmd];
    if (argc === undefined) throw new Error(`path blob: unknown command ${cmd} at byte ${o}`);
    if (o + 1 + argc * 4 > bytes.length) throw new Error(`path blob: truncated command at byte ${o}`);
    o++;
    switch (OPS[cmd]) {
      case "Z": out.push({ op: "Z" }); break;
      case "M": out.push({ op: "M", x: f(), y: f() }); break;
      case "L": out.push({ op: "L", x: f(), y: f() }); break;
      case "Q": out.push({ op: "Q", x1: f(), y1: f(), x: f(), y: f() }); break;
      case "C": out.push({ op: "C", x1: f(), y1: f(), x2: f(), y2: f(), x: f(), y: f() }); break;
    }
  }
  return out;
}

export function encodePathBlob(commands: PathCommand[]): Uint8Array {
  const size = commands.reduce((n, c) => n + 1 + ARGC[OPS.indexOf(c.op)]! * 4, 0);
  const bytes = new Uint8Array(size);
  const dv = new DataView(bytes.buffer);
  let o = 0;
  const f = (v: number) => {
    dv.setFloat32(o, v, true);
    o += 4;
  };
  for (const c of commands) {
    bytes[o++] = OPS.indexOf(c.op);
    switch (c.op) {
      case "Z": break;
      case "M": case "L": f(c.x); f(c.y); break;
      case "Q": f(c.x1); f(c.y1); f(c.x); f(c.y); break;
      case "C": f(c.x1); f(c.y1); f(c.x2); f(c.y2); f(c.x); f(c.y); break;
    }
  }
  return bytes;
}
