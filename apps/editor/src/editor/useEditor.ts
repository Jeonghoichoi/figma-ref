import { useSyncExternalStore } from "react";
import type { Editor } from "./Editor";

/** Re-renders the calling component whenever the editor changes. */
export function useEditor(editor: Editor): number {
  return useSyncExternalStore(editor.subscribe, editor.getVersion);
}
