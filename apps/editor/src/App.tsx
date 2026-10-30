import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeId } from "@figref/model";
import { Renderer, rgba, type ImageSource, type Viewport as View } from "@figref/renderer";
import { Inspector } from "./Inspector";
import { LayerPanel } from "./LayerPanel";
import { decodeImages, fetchFixture, listFixtures, loadFig, saveFig, type Loaded } from "./load";
import { Viewport, type ViewportHandle } from "./Viewport";

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<{ name: string; size: number }[]>([]);
  const [pageId, setPageId] = useState<NodeId>("");
  const [selection, setSelection] = useState<ReadonlySet<NodeId>>(new Set());
  const [hover, setHover] = useState<NodeId | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
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
      setLoaded(next);
      setSelection(new Set());
      const firstPage = [...next.doc.nodes.values()].find((n) => n.type === "CANVAS" && !n.raw?.internalOnly);
      setPageId(firstPage?.id ?? next.doc.rootId);
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

  const openFile = (file: File) => open(file.name, async () => new Uint8Array(await file.arrayBuffer()));

  const renderer = useMemo(() => (loaded ? new Renderer(loaded.doc) : null), [loaded]);

  useEffect(() => {
    const id = focusOnLoad.current;
    if (!loaded || !id || !loaded.doc.nodes.has(id)) return;
    focusOnLoad.current = null;
    setSelection(new Set([id]));
    viewport.current?.zoomTo(id);
  }, [loaded]);

  const pages = useMemo(() => {
    if (!loaded || !renderer) return [];
    return renderer.childrenOf(loaded.doc.rootId).filter((n) => n.type === "CANVAS" && !n.raw?.internalOnly);
  }, [loaded, renderer]);

  const background = useMemo(() => {
    const bg = loaded?.doc.nodes.get(pageId)?.raw?.backgroundColor as { r: number; g: number; b: number; a: number } | undefined;
    return bg ? rgba(bg) : "#f5f5f5";
  }, [loaded, pageId]);

  const select = useCallback((id: NodeId | null, additive: boolean) => {
    setSelection((s) => {
      if (!id) return additive ? s : new Set();
      if (!additive) return new Set([id]);
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.shiftKey && e.code === "Digit1") viewport.current?.zoomToFit();
      else if (e.shiftKey && e.code === "Digit0") viewport.current?.setZoom(1);
      else if (e.shiftKey && e.code === "Digit2" && selection.size) viewport.current?.zoomTo([...selection][0]!);
      else if (e.key === "Escape") setSelection(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  const fileInfo = loaded
    ? [
        `이름     ${loaded.name}`,
        `포맷     ${loaded.fig.magic} v${loaded.fig.version}`,
        `압축     ${loaded.fig.compression.join(" / ")}`,
        `스키마   정의 ${loaded.fig.schema.definitions.length}개`,
        `노드     ${loaded.doc.nodes.size}개`,
        `이미지   ${loaded.doc.images.size}개 (디코딩 ${images.current.size})`,
      ].join("\n")
    : "";

  return (
    <div
      className={`app${dragOver ? " dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) openFile(file);
      }}
    >
      <header className="toolbar">
        <strong className="brand">figref</strong>
        <label className="button">
          파일 열기
          <input type="file" accept=".fig" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
        </label>
        {fixtures.length > 0 && (
          <select
            value=""
            onChange={(e) => e.target.value && open(e.target.value, () => fetchFixture(e.target.value))}
          >
            <option value="">fixtures/ 샘플…</option>
            {fixtures.map((f) => (
              <option key={f.name} value={f.name}>{f.name} ({(f.size / 1e6).toFixed(1)} MB)</option>
            ))}
          </select>
        )}
        <button disabled={!loaded} onClick={() => loaded && saveFig(loaded)} title="현재 문서를 .fig로 다시 인코딩해 다운로드">
          .fig로 저장
        </button>
        <span className="spacer" />
        {loaded && (
          <>
            <button onClick={() => viewport.current?.zoomToFit()} title="Shift+1">전체 보기</button>
            <span className="zoom">{Math.round(view.zoom * 100)}%</span>
          </>
        )}
      </header>

      {loaded && renderer ? (
        <main className="workspace">
          <LayerPanel
            doc={loaded.doc}
            renderer={renderer}
            pages={pages}
            pageId={pageId}
            selection={selection}
            hover={hover}
            onPage={(id) => {
              setPageId(id);
              setSelection(new Set());
            }}
            onSelect={select}
            onHover={setHover}
            onFocus={(id) => {
              select(id, false);
              viewport.current?.zoomTo(id);
            }}
          />
          <div className="canvas-wrap">
            <Viewport
              ref={viewport}
              renderer={renderer}
              pageId={pageId}
              images={images.current}
              imagesVersion={imagesVersion}
              background={background}
              selection={selection}
              hover={hover}
              onSelect={select}
              onHover={setHover}
              onViewChange={setView}
            />
          </div>
          <Inspector doc={loaded.doc} renderer={renderer} selection={selection} fileInfo={fileInfo} />
        </main>
      ) : (
        <main className="empty">
          <div>
            <h1>.fig 파일을 여기로 끌어다 놓으세요</h1>
            <p>또는 위의 “파일 열기”{fixtures.length ? " / fixtures 샘플" : ""}을 사용하세요.</p>
          </div>
        </main>
      )}

      {busy && <div className="toast">{busy}</div>}
      {error && <div className="toast error" onClick={() => setError(null)}>{error}</div>}
    </div>
  );
}
