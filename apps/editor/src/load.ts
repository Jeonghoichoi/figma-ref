import { decodeFig, figToDocument, type FigFile } from "@figref/fig-format";
import type { Document } from "@figref/model";

export interface Loaded {
  name: string;
  fig: FigFile;
  doc: Document;
}

export function loadFig(name: string, bytes: Uint8Array): Loaded {
  const fig = decodeFig(bytes);
  return { name, fig, doc: figToDocument(fig) };
}

/** Decodes embedded images off the main thread; resolves per image as each finishes. */
export function decodeImages(doc: Document, onImage: (hash: string, bitmap: ImageBitmap) => void): void {
  for (const [hash, bytes] of doc.images) {
    createImageBitmap(new Blob([bytes]))
      .then((bmp) => onImage(hash, bmp))
      .catch((e) => console.warn(`image ${hash} failed to decode`, e));
  }
}

export interface Fixture {
  name: string;
  size: number;
  mtime: number;
}

export async function listFixtures(): Promise<Fixture[]> {
  try {
    const res = await fetch("/__fixtures");
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function fetchFixture(name: string): Promise<Uint8Array> {
  const res = await fetch(`/__fixtures/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
