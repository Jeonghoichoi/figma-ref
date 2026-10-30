import { buildChildIndex, type Document, type NodeId } from "@figref/model";
import type { FigFile } from "../fig-file";
import { decodeNode, encodeNode, guidToId, type BlobTable } from "./node";

/** Stored in Document.source so a save can reproduce everything we didn't map. */
export interface FigSource {
  kind: "fig";
  fig: FigFile;
  /** nodeChanges order in the source file; saves keep it for surviving nodes. */
  order: NodeId[];
}

export function figToDocument(fig: FigFile): Document {
  const t: BlobTable = { blobs: (fig.message.blobs ?? []) as BlobTable["blobs"] };
  const changes = (fig.message.nodeChanges ?? []) as Record<string, any>[];
  const nodes = new Map<NodeId, ReturnType<typeof decodeNode>>();
  let rootId: NodeId | undefined;

  for (const raw of changes) {
    const node = decodeNode(raw, t);
    if (nodes.has(node.id)) throw new Error(`duplicate node id ${node.id}`);
    nodes.set(node.id, node);
    if (node.parentId === null) {
      if (rootId !== undefined) throw new Error(`multiple root nodes: ${rootId}, ${node.id}`);
      rootId = node.id;
    }
  }
  if (rootId === undefined) throw new Error("no DOCUMENT root node");

  const source: FigSource = { kind: "fig", fig, order: changes.map((c) => guidToId(c.guid)) };
  return { rootId, nodes, images: new Map(fig.zip?.images ?? []), source };
}

/**
 * Re-encodes a Document. Documents opened from a file reuse its schema and all
 * unmapped data; new documents need a `base` file to borrow the schema from
 * (we don't ship one).
 */
export function documentToFig(doc: Document, base?: FigFile): FigFile {
  const source = isFigSource(doc.source) ? doc.source : undefined;
  const template = source?.fig ?? base;
  if (!template) throw new Error("documentToFig: document has no source file; pass a base .fig to take the schema from");

  // Existing blobs keep their indices so untouched geometry references stay valid.
  const t: BlobTable = { blobs: source ? [...((source.fig.message.blobs ?? []) as BlobTable["blobs"])] : [] };

  const order: NodeId[] = (source?.order ?? []).filter((id) => doc.nodes.has(id));
  const placed = new Set(order);
  // New nodes go after existing ones, parents before children.
  const children = buildChildIndex(doc);
  const stack: NodeId[] = [doc.rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (!placed.has(id)) {
      order.push(id);
      placed.add(id);
    }
    const kids = children.get(id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!.id);
  }
  const orphans = [...doc.nodes.keys()].filter((id) => !placed.has(id));
  if (orphans.length) throw new Error(`nodes not reachable from root: ${orphans.slice(0, 5).join(", ")}`);

  const nodeChanges = order.map((id) => encodeNode(doc.nodes.get(id)!, t));
  const message = source
    ? { ...source.fig.message, nodeChanges, blobs: t.blobs }
    : { type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges, blobs: t.blobs };

  const zip = template.zip && source
    ? { ...template.zip, images: new Map(doc.images) }
    : { meta: { file_name: "Untitled" }, images: new Map(doc.images), other: new Map<string, Uint8Array>() };

  return {
    magic: template.magic,
    version: template.version,
    schema: template.schema,
    compression: template.compression,
    extraChunks: source ? template.extraChunks : [],
    message,
    zip,
  };
}

function isFigSource(v: unknown): v is FigSource {
  return typeof v === "object" && v !== null && (v as FigSource).kind === "fig";
}
