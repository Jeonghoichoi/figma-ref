import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFig, documentToFig, encodeFig, figToDocument } from "@figref/fig-format";
import type { NodeId } from "@figref/model";
import { rgba, type ImageSource, type Viewport as View } from "@figref/renderer";
import { Editor, type Tool } from "./editor/Editor";
import { useEditor } from "./editor/useEditor";
import { Inspector } from "./Inspector";
import { LayerPanel } from "./LayerPanel";
import { decodeImages, fetchFixture, listFixtures, loadFig, saveFig, type Loaded } from "./load";
import { Viewport, type ViewportHandle } from "./Viewport";

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "선택", key: "V", icon: "➤" },
  { id: "hand", label: "손", key: "H", icon: "✋" },
  { id: "frame", label: "프레임", key: "F", icon: "#" },
  { id: "rectangle", label: "사각형", key: "R", icon: "□" },
  { id: "ellipse", label: "원", key: "O", icon: "○" },
  { id: "line", label: "선", key: "L", icon: "╱" },
  { id: "text", label: "텍스트", key: "T", icon: "T" },
];
const TOOL_KEYS: Record<string, Tool> = { v: "select", h: "hand", f: "frame", a: "frame", r: "rectangle", o: "ellipse", l: "line", t: "text" };

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<{ name: string; size: number }[]>([]);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [editingText, setEditingText] = useState<NodeId | null>(null);
  const images = useRef(new Map<string, ImageSource>());
  const [imagesVersion, setImagesVersion] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const viewport = useRef<ViewportHandle>(null);

  useEffect(() => {
    listFixtures().then(setFixtures);
  }, []);

  const open = useCallback(async (name: string, getBytes: () => Promise<Uint8Array>) => {
    setError(null);
    setBusy(`${name} 여는 중…`);
    try {
      const bytes = await getBytes();
      await new Promise((r) => setTimeout(r, 0)); // let the "opening" state paint
      const t0 = performance.now();
      const next = loadFig(name, bytes);
      console.info(`[figref] ${name}: decoded ${next.doc.nodes.size} nodes in ${Math.round(performance.now() - t0)} ms`);
      images.current = new Map();
      decodeImages(next.doc, (hash, bmp) => {
        images.current.set(hash, bmp);
        setImagesVersion((v) => v + 1);
      });
      const firstPage = [...next.doc.nodes.values()].find((n) => n.type === "CANVAS" && !n.raw?.internalOnly);
      setLoaded(next);
      setEditor(new Editor(next.doc, firstPage?.id ?? next.doc.rootId));
      setEditingText(null);
    } catch (e) {
      console.error(e);
      setError(`${name}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, []);

  // ?open=<fixture name>[&node=<id>] opens a local sample directly (dev server only).
  const focusOnLoad = useRef(new URLSearchParams(location.search).get("node"));
  useEffect(() => {
    const name = new URLSearchParams(location.search).get("open");
    if (name) open(name, () => fetchFixture(name));
  }, [open]);

  useEffect(() => {
    const id = focusOnLoad.current;
    if (editor && id && editor.doc.nodes.has(id)) editor.select([id]);
  }, [editor]);

  // Dev-only handle for console debugging and browser-driven tests.
  useEffect(() => {
    if (!import.meta.env.DEV || !editor || !loaded) return;
    (window as any).__figref = {
      editor,
      loaded,
      /** Saves to .fig bytes and reopens them, like a save + reload would. */
      roundtrip: () => {
        const bytes = encodeFig(documentToFig(editor.doc));
        return { bytes: bytes.length, doc: figToDocument(decodeFig(bytes)) };
      },
    };
  }, [editor, loaded]);

  const openFile = (file: File) => open(file.name, async () => new Uint8Array(await file.arrayBuffer()));

  const save = useCallback(() => {
    if (!loaded || !editor) return;
    try {
      saveFig(loaded);
      editor.dirty = false;
      editor.preview();
    } catch (e) {
      console.error(e);
      setError(`저장 실패: ${(e as Error).message}`);
    }
  }, [loaded, editor]);

  // Warn before leaving with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor?.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const sel = [...editor.selection];
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      if (mod && key === "z") return run(() => (e.shiftKey ? editor.redo() : editor.undo()));
      if (mod && key === "y") return run(() => editor.redo());
      if (mod && key === "s") return run(save);
      if (mod && key === "d") return run(() => editor.duplicate());
      if (mod && key === "c") return run(() => editor.copy());
      if (mod && key === "x") return run(() => { editor.copy(); editor.deleteSelection(); });
      if (mod && key === "v") return run(() => editor.paste());
      if (mod && key === "g") return run(() => (e.shiftKey ? editor.ungroup() : editor.group()));
      if (mod && key === "a") return run(() => {
        const parent = sel.length ? editor.node(sel[0]!).parentId! : editor.pageId;
        editor.select(editor.renderer.childrenOf(parent).filter((n) => n.visible && !n.locked).map((n) => n.id));
      });
      if (mod && e.code === "BracketRight") return run(() => editor.reorder(e.altKey ? "front" : "forward"));
      if (mod && e.code === "BracketLeft") return run(() => editor.reorder(e.altKey ? "back" : "backward"));
      if (mod && e.shiftKey && key === "h") return run(() => sel.forEach((id) => editor.toggle(id, "visible")));
      if (mod && e.shiftKey && key === "l") return run(() => sel.forEach((id) => editor.toggle(id, "locked")));
      if (mod) return;

      if (e.shiftKey && e.code === "Digit1") return run(() => viewport.current?.zoomToFit());
      if (e.shiftKey && e.code === "Digit0") return run(() => viewport.current?.setZoom(1));
      if (e.shiftKey && e.code === "Digit2" && sel.length) return run(() => viewport.current?.zoomTo(sel[0]!));
      if (key === "backspace" || key === "delete") return run(() => editor.deleteSelection());
      if (key === "escape") return run(() => {
        const parent = sel.length === 1 ? editor.node(sel[0]!).parentId : null;
        editor.select(parent && parent !== editor.pageId ? [parent] : []);
        editor.setTool("select");
      });
      if (key === "enter" && sel.length === 1) return run(() => {
        if (e.shiftKey) {
          const parent = editor.node(sel[0]!).parentId;
          if (parent && parent !== editor.pageId) editor.select([parent]);
        } else if (editor.node(sel[0]!).type === "TEXT") {
          setEditingText(sel[0]!);
        } else {
          const kids = editor.renderer.childrenOf(sel[0]!);
          if (kids.length) editor.select(kids.map((k) => k.id));
        }
      });
      if (key.startsWith("arrow") && sel.length) return run(() => {
        const step = e.shiftKey ? 10 : 1;
        const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
        const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
        editor.transact(() => editor.translate(sel, new Map(), dx, dy));
      });
      const tool = TOOL_KEYS[key];
      if (tool && !e.altKey) return run(() => editor.setTool(tool));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, save]);

  return (
    <div
      className={`app${dragOver ? " dragover" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        openFile(e.dataTransfer.files[0]!);
      }}
    >
      <header className="toolbar">
        <strong className="brand">figref</strong>
        {editor && <Tools editor={editor} />}
        <span className="divider" />
        <label className="button">
          열기
          <input type="file" accept=".fig" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
        </label>
        {fixtures.length > 0 && (
          <select value="" onChange={(e) => e.target.value && open(e.target.value, () => fetchFixture(e.target.value))}>
            <option value="">fixtures/ 샘플…</option>
            {fixtures.map((f) => (
              <option key={f.name} value={f.name}>{f.name} ({(f.size / 1e6).toFixed(1)} MB)</option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {editor && loaded && <Status editor={editor} name={loaded.name} onSave={save} />}
        {editor && (
          <>
            <button onClick={() => viewport.current?.zoomToFit()} title="Shift+1">전체 보기</button>
            <span className="zoom">{Math.round(view.zoom * 100)}%</span>
          </>
        )}
      </header>

      {editor && loaded ? (
        <main className="workspace">
          <LayerPanel editor={editor} onFocus={(id) => { editor.select([id]); viewport.current?.zoomTo(id); }} />
          <div className="canvas-wrap">
            <Viewport
              ref={viewport}
              editor={editor}
              images={images.current}
              imagesVersion={imagesVersion}
              background={pageBackground(editor)}
              editingText={editingText}
              initialFocus={focusOnLoad.current}
              onEditText={setEditingText}
              onViewChange={setView}
            />
          </div>
          <Inspector editor={editor} fileInfo={fileInfo(loaded, images.current.size)} />
        </main>
      ) : (
        <main className="empty">
          <div>
            <h1>.fig 파일을 여기로 끌어다 놓으세요</h1>
            <p>또는 위의 “열기”{fixtures.length ? " / fixtures 샘플" : ""}을 사용하세요.</p>
          </div>
        </main>
      )}

      {busy && <div className="toast">{busy}</div>}
      {error && <div className="toast error" onClick={() => setError(null)}>{error}</div>}
    </div>
  );
}

function Tools({ editor }: { editor: Editor }) {
  useEditor(editor);
  return (
    <div className="tools">
      {TOOLS.map((t) => (
        <button key={t.id} className={editor.tool === t.id ? "active" : ""} title={`${t.label} (${t.key})`} onClick={() => editor.setTool(t.id)}>
          {t.icon}
        </button>
      ))}
      <span className="divider" />
      <button disabled={!editor.canUndo} title="실행 취소 (⌘Z)" onClick={() => editor.undo()}>↶</button>
      <button disabled={!editor.canRedo} title="다시 실행 (⇧⌘Z)" onClick={() => editor.redo()}>↷</button>
    </div>
  );
}

function Status({ editor, name, onSave }: { editor: Editor; name: string; onSave(): void }) {
  useEditor(editor);
  return (
    <>
      <span className="filename">{name}{editor.dirty ? " •" : ""}</span>
      <button onClick={onSave} title="⌘S — 현재 문서를 .fig로 저장(다운로드)">.fig로 저장</button>
    </>
  );
}

function pageBackground(editor: Editor): string {
  const bg = editor.doc.nodes.get(editor.pageId)?.raw?.backgroundColor as { r: number; g: number; b: number; a: number } | undefined;
  return bg ? rgba(bg) : "#f5f5f5";
}

function fileInfo(loaded: Loaded, decodedImages: number): string {
  return [
    `이름     ${loaded.name}`,
    `포맷     ${loaded.fig.magic} v${loaded.fig.version}`,
    `압축     ${loaded.fig.compression.join(" / ")}`,
    `스키마   정의 ${loaded.fig.schema.definitions.length}개`,
    `노드     ${loaded.doc.nodes.size}개`,
    `이미지   ${loaded.doc.images.size}개 (디코딩 ${decodedImages})`,
  ].join("\n");
}
