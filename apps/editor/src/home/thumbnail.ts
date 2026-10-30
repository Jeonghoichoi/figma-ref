import { rgba, type ImageSource } from "@figref/renderer";
import type { Editor } from "../editor/Editor";

const W = 400;
const H = 240;

/** Renders the current page, fitted, into a small PNG for the file browser and the .fig's thumbnail.png. */
export async function renderThumbnail(editor: Editor, images: Map<string, ImageSource>): Promise<Blob | null> {
  const bounds = editor.renderer.pageBounds(editor.pageId);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const bg = editor.doc.nodes.get(editor.pageId)?.raw?.backgroundColor as { r: number; g: number; b: number; a: number } | undefined;
  let view = { zoom: 1, x: W / 2, y: H / 2 };
  if (bounds) {
    const pad = 16;
    const zoom = Math.min((W - pad * 2) / Math.max(bounds.w, 1), (H - pad * 2) / Math.max(bounds.h, 1));
    view = { zoom, x: W / 2 - (bounds.x + bounds.w / 2) * zoom, y: H / 2 - (bounds.y + bounds.h / 2) * zoom };
  }
  editor.renderer.render(ctx, editor.pageId, view, { images, background: bg ? rgba(bg) : "#f5f5f5", labels: false });
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
