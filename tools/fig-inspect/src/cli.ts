// fig-inspect — reverse-engineering helper for .fig files.
//
//   pnpm inspect <file.fig>                    summary
//   pnpm inspect <file.fig> --out <dir>        + schema.kiwi, message.json, field-usage.json, tree.txt
//   pnpm inspect <file.fig> --roundtrip        decode → encode → decode and report differences
//   pnpm inspect <file.fig> --remove-node 7:2 [--remove-node …] --write <out.fig>
//                                              delete subtrees (plus now-unused blobs, images
//                                              and the thumbnail) and write the result
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { decodeFig, encodeFig, isZip, pruneFig, toJSONValue } from "@figref/fig-format";
import { printSchema } from "@figref/kiwi";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    roundtrip: { type: "boolean", default: false },
    "max-bytes": { type: "string", default: "64" },
    "remove-node": { type: "string", multiple: true },
    write: { type: "string" },
  },
});

const file = positionals[0];
if (!file) {
  console.error("usage: fig-inspect <file.fig> [--out dir] [--roundtrip] [--max-bytes n] [--remove-node id … --write out.fig]");
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(file));
const fieldUsage = new Map<string, number>();
const t0 = performance.now();
const fig = decodeFig(bytes, {
  onField: (message, field) => {
    const key = `${message}.${field}`;
    fieldUsage.set(key, (fieldUsage.get(key) ?? 0) + 1);
  },
});
const decodeMs = performance.now() - t0;

type NodeChange = {
  guid?: { sessionID: number; localID: number };
  parentIndex?: { guid: { sessionID: number; localID: number }; position: string };
  type?: string;
  name?: string;
};
const nodes = (fig.message.nodeChanges ?? []) as NodeChange[];
const blobs = (fig.message.blobs ?? []) as unknown[];

const byType = new Map<string, number>();
for (const n of nodes) byType.set(String(n.type), (byType.get(String(n.type)) ?? 0) + 1);

console.log(`file          ${basename(file)} (${bytes.length.toLocaleString()} bytes, ${isZip(bytes) ? "ZIP" : "raw"})`);
console.log(`header        ${fig.magic} v${fig.version}`);
console.log(`compression   schema=${fig.compression[0]} message=${fig.compression[1]}${fig.extraChunks.length ? ` (+${fig.extraChunks.length} extra chunks)` : ""}`);
console.log(`schema        ${fig.schema.definitions.length} definitions`);
console.log(`message       type=${String(fig.message.type)} nodeChanges=${nodes.length} blobs=${blobs.length}  (decoded in ${decodeMs.toFixed(0)} ms)`);
if (fig.zip) console.log(`zip           images=${fig.zip.images.size} thumbnail=${fig.zip.thumbnail ? "yes" : "no"} other=[${[...fig.zip.other.keys()].join(", ")}]`);
console.log("node types    " + [...byType].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}:${c}`).join(" "));

if (values.out) {
  const out = values.out;
  mkdirSync(out, { recursive: true });
  const maxBytes = Number(values["max-bytes"]);

  writeFileSync(join(out, "schema.kiwi"), printSchema(fig.schema));
  writeFileSync(join(out, "message.json"), JSON.stringify(toJSONValue(fig.message, { maxBytes }), null, 1));
  if (fig.zip?.meta !== undefined) writeFileSync(join(out, "meta.json"), JSON.stringify(fig.zip.meta, null, 2));

  // Which fields does this file actually use? Sorted by frequency — the starting
  // point for deciding what step 3 must map vs. what can stay in `raw`.
  const usage = Object.fromEntries([...fieldUsage].sort((a, b) => a[0].localeCompare(b[0])));
  writeFileSync(join(out, "field-usage.json"), JSON.stringify(usage, null, 2));

  writeFileSync(join(out, "tree.txt"), renderTree(nodes));
  console.log(`\nwrote schema.kiwi, message.json, field-usage.json, tree.txt${fig.zip?.meta !== undefined ? ", meta.json" : ""} → ${out}`);
}

if (values["remove-node"]?.length) {
  if (!values.write) {
    console.error("--remove-node needs --write <out.fig>");
    process.exit(2);
  }
  const { fig: pruned, removedNodes, removedBlobs, removedImages } = pruneFig(fig, values["remove-node"]);
  const out = encodeFig(pruned);
  writeFileSync(values.write, out);
  console.log(`\nremoved      ${removedNodes} nodes, ${removedBlobs} blobs, ${removedImages.length} images${fig.zip?.thumbnail ? ", thumbnail" : ""}`);
  console.log(`wrote        ${values.write} (${out.length.toLocaleString()} bytes)`);
}

if (values.roundtrip) {
  const t1 = performance.now();
  const reencoded = encodeFig(fig);
  const back = decodeFig(reencoded);
  const ms = performance.now() - t1;
  const diffs = diffPaths(fig.message, back.message, "message", 20);
  const schemaSame = isDeepStrictEqual(fig.schema, back.schema);
  console.log(`\nroundtrip     ${reencoded.length.toLocaleString()} bytes (${ms.toFixed(0)} ms)`);
  console.log(`  schema      ${schemaSame ? "identical" : "DIFFERENT"}`);
  console.log(`  message     ${diffs.length === 0 ? "identical" : `${diffs.length}+ differences`}`);
  for (const d of diffs) console.log(`    ${d}`);
  if (!schemaSame || diffs.length) process.exitCode = 1;
}

function guidKey(g: { sessionID: number; localID: number } | undefined): string {
  return g ? `${g.sessionID}:${g.localID}` : "?";
}

function renderTree(nodes: NodeChange[]): string {
  const children = new Map<string, NodeChange[]>();
  const ids = new Set(nodes.map((n) => guidKey(n.guid)));
  const roots: NodeChange[] = [];
  for (const n of nodes) {
    const parent = n.parentIndex ? guidKey(n.parentIndex.guid) : null;
    if (parent === null || !ids.has(parent)) roots.push(n);
    else (children.get(parent) ?? children.set(parent, []).get(parent)!).push(n);
  }
  const lines: string[] = [];
  const walk = (n: NodeChange, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${n.type} ${JSON.stringify(n.name ?? "")} [${guidKey(n.guid)}] pos=${JSON.stringify(n.parentIndex?.position ?? "")}`);
    const kids = (children.get(guidKey(n.guid)) ?? []).sort((a, b) => ((a.parentIndex!.position < b.parentIndex!.position) ? -1 : 1));
    for (const c of kids) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines.join("\n") + "\n";
}

function diffPaths(a: unknown, b: unknown, path: string, limit: number, out: string[] = []): string[] {
  if (out.length >= limit) return out;
  if (isDeepStrictEqual(a, b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && !(a instanceof Uint8Array)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths((a as any)[k], (b as any)[k], `${path}.${k}`, limit, out);
    return out;
  }
  out.push(`${path}: ${fmt(a)} → ${fmt(b)}`);
  return out;
}

function fmt(v: unknown): string {
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (typeof v === "bigint") return `${v}n`;
  return JSON.stringify(v) ?? String(v);
}
