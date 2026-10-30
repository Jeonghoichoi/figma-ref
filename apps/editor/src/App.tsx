import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFig, documentToFig, encodeFig, figToDocument } from "@figref/fig-format";
import type { NodeId } from "@figref/model";
import { rgba, type ImageSource, type Viewport as View } from "@figref/renderer";
import { Editor, type Tool } from "./editor/Editor";
import { useEditor } from "./editor/useEditor";
import { createFig, download, importFig, openStored, persist, type OpenFile } from "./home/files";
import { Home } from "./home/Home";
import { getBytes, getFile, listFiles, rememberSchema, renameFile } from "./home/library";
import type { Preset } from "./home/presets";
import { Inspector } from "./Inspector";
import { LayerPanel } from "./LayerPanel";
import { decodeImages, fetchFixture, listFixtures, type Fixture } from "./load";
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
const AUTOSAVE_MS = 1500;

type SaveState = "saved" | "saving" | "unsaved";

export function App() {
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [editingText, setEditingText] = useState<NodeId | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const images = useRef(new Map<string, ImageSource>());
  const [imagesVersion, setImagesVersion] = useState(0);
  const viewport = useRef<ViewportHandle>(null);
  const focusOnLoad = useRef(new URLSearchParams(location.search).get("node"));

  useEffect(() => {
    listFixtures().then(setFixtures);
  }, []);

  const fail = (what: string, e: unknown) => {
    console.error(e);
    setError(`${what}: ${(e as Error).message}`);
  };

  /** Runs a file-producing step with a busy toast, then opens the result in the editor. */
  const openWith = useCallback(async (label: string, produce: () => Promise<OpenFile>) => {
    setError(null);
    setBusy(label);
    try {
      await new Promise((r) => setTimeout(r, 0)); // let the toast paint before heavy decoding
      const t0 = performance.now();
      const next = await produce();
      console.info(`[figref] ${next.file.name}: ${next.doc.nodes.size} nodes in ${Math.round(performance.now() - t0)} ms`);
      await rememberSchema(next.fig);
      images.current = new Map();
      decodeImages(next.doc, (hash, bmp) => {
        images.current.set(hash, bmp);
        setImagesVersion((v) => v + 1);
      });
      const firstPage = [...next.doc.nodes.values()].find((n) => n.type === "CANVAS" && !n.raw?.internalOnly);
      setOpen(next);
      setEditor(new Editor(next.doc, firstPage?.id ?? next.doc.rootId));
      setEditingText(null);
      setSaveState("saved");
      history.replaceState(null, "", `${location.pathname}${location.search}#file=${next.file.id}`);
    } catch (e) {
      fail(label.replace(/ 중…$/, ""), e);
    } finally {
      setBusy(null);
      setLibraryVersion((v) => v + 1);
    }
  }, []);

  const onNew = (preset: Preset | null) => openWith("새 파일 만드는 중…", () => createFig(preset));
  const onImport = (file: File) =>
    openWith(`${file.name} 가져오는 중…`, async () => importFig(file.name, new Uint8Array(await file.arrayBuffer()), "import"));
  const onOpenStored = (id: string) =>
    openWith("여는 중…", async () => {
      const [file, bytes] = await Promise.all([getFile(id), getBytes(id)]);
      if (!file || !bytes) throw new Error("라이브러리에서 파일을 찾을 수 없습니다");
      return openStored(file, bytes);
    });
  // A sample opens its existing library copy if there is one (edits live there), else imports a copy.
  const onOpenSample = (name: string) =>
    openWith(`${name} 여는 중…`, async () => {
      const copy = (await listFiles()).find((f) => f.origin === "sample" && f.name === name.replace(/\.fig$/, ""));
      const bytes = copy && (await getBytes(copy.id));
      return copy && bytes ? openStored(copy, bytes) : importFig(name, await fetchFixture(name), "sample");
    });

  // Initial route: #file=<id> reopens a library file (survives reloads); ?open=<fixture> opens a sample.
  useEffect(() => {
    const id = /#file=([\w-]+)/.exec(location.hash)?.[1];
    const sample = new URLSearchParams(location.search).get("open");
    if (id) onOpenStored(id);
    else if (sample) onOpenSample(sample);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = focusOnLoad.current;
    if (editor && id && editor.doc.nodes.has(id)) editor.select([id]);
  }, [editor]);

  // ---- saving ----------------------------------------------------------------

  const saving = useRef<Promise<void> | null>(null);
  const save = useCallback(async (): Promise<Uint8Array | null> => {
    if (!open || !editor) return null;
    await saving.current; // one save at a time
    let bytes: Uint8Array | null = null;
    const run = (async () => {
      editor.dirty = false; // edits made while saving mark it dirty again
      setSaveState("saving");
      try {
        const result = await persist(open, editor, images.current);
        bytes = result.bytes;
        setOpen((o) => (o && o.file.id === result.file.id ? { ...o, file: result.file } : o));
        setSaveState(editor.dirty ? "unsaved" : "saved");
      } catch (e) {
        editor.dirty = true;
        setSaveState("unsaved");
        fail("저장 실패", e);
      }
    })();
    saving.current = run;
    await run;
    return bytes;
  }, [open, editor]);

  // Autosave shortly after the last edit.
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = editor.subscribe(() => {
      if (!editor.dirty) return;
      setSaveState("unsaved");
      clearTimeout(timer);
      timer = setTimeout(() => void save(), AUTOSAVE_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [editor, save]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (editor?.dirty || saveState === "saving") e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor, saveState]);

  const goHome = async () => {
    if (editor?.dirty) await save();
    else await saving.current;
    setOpen(null);
    setEditor(null);
    setEditingText(null);
    history.replaceState(null, "", location.pathname);
    setLibraryVersion((v) => v + 1);
  };

  const exportFig = async () => {
    const bytes = await save();
    if (bytes && open) download(open.file.name, bytes);
  };

  const rename = async (name: string) => {
    if (!open || !name.trim() || name === open.file.name) return;
    await renameFile(open.file.id, name.trim());
    setOpen({ ...open, file: { ...open.file, name: name.trim() } });
  };

  // Dev-only handle for console debugging and browser-driven tests.
  useEffect(() => {
    if (!import.meta.env.DEV || !editor || !open) return;
    (window as any).__figref = {
      editor,
      open,
      save,
      /** Saves to .fig bytes and reopens them, like a save + reload would. */
      roundtrip: () => {
        const bytes = encodeFig(documentToFig(editor.doc));
        return { bytes: bytes.length, doc: figToDocument(decodeFig(bytes)) };
      },
    };
  }, [editor, open, save]);

  // ---- shortcuts ------------------------------------------------------------------

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
      if (mod && key === "s") return run(() => void save());
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

  // ---- render ---------------------------------------------------------------------

  const toasts = (
    <>
      {busy && <div className="toast">{busy}</div>}
      {error && <div className="toast error" onClick={() => setError(null)} title="닫기">{error}</div>}
    </>
  );

  if (!editor || !open) {
    return (
      <div className="app">
        <Home
          fixtures={fixtures}
          libraryVersion={libraryVersion}
          onNew={onNew}
          onImport={onImport}
          onOpen={(f) => onOpenStored(f.id)}
          onOpenSample={onOpenSample}
        />
        {toasts}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button className="home-btn" onClick={goHome} title="홈으로 (최근 파일)">◆</button>
        <Tools editor={editor} />
        <span className="spacer" />
        <input
          key={open.file.id + open.file.name}
          className="title-input"
          defaultValue={open.file.name}
          title="파일 이름 바꾸기"
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => void rename(e.target.value)}
        />
        <span className={`save-state ${saveState}`}>{saveState === "saved" ? "저장됨" : saveState === "saving" ? "저장 중…" : "편집됨"}</span>
        <span className="spacer" />
        <button onClick={exportFig} title="현재 문서를 .fig 파일로 다운로드">.fig 다운로드</button>
        <button onClick={() => viewport.current?.zoomToFit()} title="Shift+1">전체 보기</button>
        <span className="zoom">{Math.round(view.zoom * 100)}%</span>
      </header>

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
        <Inspector editor={editor} fileInfo={fileInfo(open, images.current.size)} />
      </main>
      {toasts}
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

function pageBackground(editor: Editor): string {
  const bg = editor.doc.nodes.get(editor.pageId)?.raw?.backgroundColor as { r: number; g: number; b: number; a: number } | undefined;
  return bg ? rgba(bg) : "#f5f5f5";
}

function fileInfo(open: OpenFile, decodedImages: number): string {
  return [
    `이름     ${open.file.name}`,
    `포맷     ${open.fig.magic} v${open.fig.version}`,
    `압축     ${open.fig.compression.join(" / ")}`,
    `스키마   정의 ${open.fig.schema.definitions.length}개`,
    `노드     ${open.doc.nodes.size}개`,
    `이미지   ${open.doc.images.size}개 (디코딩 ${decodedImages})`,
  ].join("\n");
}
