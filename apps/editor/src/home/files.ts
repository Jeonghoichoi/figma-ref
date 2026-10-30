import { decodeFig, documentToFig, encodeFig, figToDocument } from "@figref/fig-format";
import { createDocument, createNode, insertNode, primitiveGeometry } from "@figref/model";
import type { Editor } from "../editor/Editor";
import { loadFig, type Loaded } from "../load";
import { baseFig, newFileId, rememberSchema, saveFile, type LibraryFile } from "./library";
import type { Preset } from "./presets";
import { renderThumbnail } from "./thumbnail";

export class NoSchemaError extends Error {
  constructor() {
    super("새 파일을 만들려면 .fig 파일을 한 번 이상 가져와야 합니다. 파일 형식(스키마)을 기존 파일에서 읽어 오기 때문입니다.");
  }
}

/** An open file: the decoded document plus its library record. */
export interface OpenFile extends Loaded {
  file: LibraryFile;
}

function baseName(name: string): string {
  return name.replace(/\.fig$/i, "");
}

/** Imports .fig bytes into the library and opens them. */
export async function importFig(name: string, bytes: Uint8Array, origin: LibraryFile["origin"]): Promise<OpenFile> {
  const loaded = loadFig(name, bytes);
  await rememberSchema(loaded.fig);
  const now = Date.now();
  const thumb = loaded.fig.zip?.thumbnail;
  const file: LibraryFile = {
    id: newFileId(),
    name: baseName(name),
    createdAt: now,
    updatedAt: now,
    size: bytes.length,
    thumbnail: thumb ? new Blob([thumb], { type: "image/png" }) : undefined,
    origin,
  };
  await saveFile(file, bytes);
  return { ...loaded, file };
}

export function openStored(file: LibraryFile, bytes: Uint8Array): OpenFile {
  return { ...loadFig(file.name, bytes), file };
}

/**
 * Creates a real .fig in the library: an empty page, optionally with one
 * artboard (frame) of a preset size. The schema comes from a previously
 * opened file, since we don't ship one.
 */
export async function createFig(preset: Preset | null): Promise<OpenFile> {
  const base = await baseFig();
  if (!base) throw new NoSchemaError();

  const doc = createDocument();
  if (preset) {
    const frame = createNode({
      id: "1:1",
      type: "FRAME",
      name: preset.label,
      size: { x: preset.w, y: preset.h },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: "NORMAL" }],
      clipsContent: true,
      strokeAlign: "INSIDE",
    });
    frame.fillGeometry = primitiveGeometry(frame);
    insertNode(doc, frame, "0:1");
  }
  const name = preset ? `${preset.label} 디자인` : "제목 없음";
  // Round-trip once so the document carries a FigSource like any opened file.
  const bytes = encodeFig({ ...documentToFig(doc, base), zip: { meta: { file_name: name }, images: new Map(), other: new Map() } });
  const fig = decodeFig(bytes);
  const now = Date.now();
  const file: LibraryFile = { id: newFileId(), name, createdAt: now, updatedAt: now, size: bytes.length, origin: "new" };
  await saveFile(file, bytes);
  return { name, fig, doc: figToDocument(fig), file };
}

/** Encodes the current document (with a fresh thumbnail) and stores it in the library. */
export async function persist(open: OpenFile, editor: Editor, images: Map<string, CanvasImageSource & { width: number; height: number }>): Promise<{ file: LibraryFile; bytes: Uint8Array }> {
  const thumbnail = await renderThumbnail(editor, images);
  const fig = documentToFig(open.doc);
  if (fig.zip) {
    if (thumbnail) fig.zip.thumbnail = new Uint8Array(await thumbnail.arrayBuffer());
    fig.zip.meta = { ...(fig.zip.meta as object), file_name: open.file.name };
  }
  const bytes = encodeFig(fig);
  const file: LibraryFile = { ...open.file, updatedAt: Date.now(), size: bytes.length, thumbnail: thumbnail ?? open.file.thumbnail };
  await saveFile(file, bytes);
  return { file, bytes };
}

export function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${baseName(name)}.fig` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
