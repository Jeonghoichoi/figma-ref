import type { Schema } from "@figref/kiwi";
import type { FigFile } from "./fig-file";

// Removing content from a .fig for real: dropping NodeChanges alone leaves
// their glyph outlines / geometry in Message.blobs and their pictures in
// images/. pruneFig removes subtrees, then garbage-collects both.

type Raw = Record<string, any>;
const key = (g: { sessionID: number; localID: number }) => `${g.sessionID}:${g.localID}`;

/** uint fields named *Blob hold indices into Message.blobs (commandsBlob, vectorNetworkBlob, dataBlob). */
export function blobRefFields(schema: Schema): Set<string> {
  const out = new Set<string>();
  for (const d of schema.definitions) {
    for (const f of d.fields) if (f.type === "uint" && !f.isArray && f.name.endsWith("Blob")) out.add(f.name);
  }
  return out;
}

function walk(v: unknown, fn: (obj: Raw) => void): void {
  if (Array.isArray(v)) v.forEach((x) => walk(x, fn));
  else if (v && typeof v === "object" && !(v instanceof Uint8Array)) {
    fn(v as Raw);
    for (const x of Object.values(v)) walk(x, fn);
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export interface PruneResult {
  fig: FigFile;
  removedNodes: number;
  removedBlobs: number;
  removedImages: string[];
}

/**
 * Returns a copy of `fig` without the given nodes and their descendants,
 * without blobs and images nothing references any more, and (by default)
 * without the embedded thumbnail, which may still show removed content.
 */
export function pruneFig(fig: FigFile, ids: Iterable<string>, opts: { keepThumbnail?: boolean } = {}): PruneResult {
  const message = structuredClone(fig.message) as Raw;
  const nodes = (message.nodeChanges ?? []) as Raw[];

  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentIndex) continue;
    const p = key(n.parentIndex.guid);
    children.set(p, [...(children.get(p) ?? []), key(n.guid)]);
  }
  const doomed = new Set<string>();
  const stack = [...ids];
  for (const id of stack) {
    if (!nodes.some((n) => key(n.guid) === id)) throw new Error(`node ${id} not found`);
  }
  while (stack.length) {
    const id = stack.pop()!;
    if (doomed.has(id)) continue;
    doomed.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  message.nodeChanges = nodes.filter((n) => !doomed.has(key(n.guid)));

  // Blob GC: keep referenced blobs in their original order, renumber references.
  const refFields = blobRefFields(fig.schema);
  const blobs = (message.blobs ?? []) as unknown[];
  const { blobs: _ignored, ...rest } = message;
  void _ignored;
  const used = new Set<number>();
  walk(rest, (o) => {
    for (const f of refFields) if (typeof o[f] === "number") used.add(o[f]);
  });
  const remap = new Map<number, number>();
  const kept: unknown[] = [];
  blobs.forEach((b, i) => {
    if (used.has(i)) {
      remap.set(i, kept.length);
      kept.push(b);
    }
  });
  walk(rest, (o) => {
    for (const f of refFields) if (typeof o[f] === "number") o[f] = remap.get(o[f])!;
  });
  message.blobs = kept;

  // Image GC: images/<sha1> entries are referenced by 20-byte `hash` fields (Paint.image, imageThumbnail, …).
  let zip = fig.zip;
  let removedImages: string[] = [];
  if (zip) {
    const referenced = new Set<string>();
    walk(message, (o) => {
      if (o.hash instanceof Uint8Array && o.hash.length === 20) referenced.add(hex(o.hash));
    });
    removedImages = [...zip.images.keys()].filter((h) => !referenced.has(h));
    zip = {
      ...zip,
      images: new Map([...zip.images].filter(([h]) => referenced.has(h))),
      thumbnail: opts.keepThumbnail ? zip.thumbnail : undefined,
    };
  }

  return {
    fig: { ...fig, message, zip },
    removedNodes: doomed.size,
    removedBlobs: blobs.length - kept.length,
    removedImages,
  };
}
