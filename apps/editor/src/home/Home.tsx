import { useEffect, useMemo, useRef, useState } from "react";
import { deleteFile, getBytes, listFiles, renameFile, type LibraryFile } from "./library";
import { download } from "./files";
import { PRESETS, type Preset } from "./presets";

interface Fixture {
  name: string;
  size: number;
  mtime: number;
}

interface Props {
  fixtures: Fixture[];
  /** Bumped by the app when the library changed (save, import), to refresh the list. */
  libraryVersion: number;
  onNew(preset: Preset | null): void;
  onImport(file: File): void;
  onOpen(file: LibraryFile): void;
  onOpenSample(name: string): void;
}

export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "방금 전";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.round(h / 24);
  if (d === 1) return "어제";
  if (d < 7) return `${d}일 전`;
  return new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });
}

const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function Home({ fixtures, libraryVersion, onNew, onImport, onOpen, onOpenSample }: Props) {
  const [files, setFiles] = useState<LibraryFile[] | null>(null);
  const [tab, setTab] = useState<"recent" | "samples">("recent");
  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [, tick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => listFiles().then(setFiles).catch(() => setFiles([]));
  useEffect(() => {
    refresh();
  }, [libraryVersion]);
  // Keep "N분 전" labels fresh.
  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const q = query.trim().toLowerCase();
  const shownFiles = (files ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const shownFixtures = fixtures.filter((f) => !q || f.name.toLowerCase().includes(q));

  return (
    <div
      className={`home${dragOver ? " dragover" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onImport(f);
      }}
    >
      <aside className="home-side">
        <div className="home-brand">
          <span className="logo">◆</span> figref
        </div>
        <nav>
          <button className={tab === "recent" ? "active" : ""} onClick={() => setTab("recent")}>
            <span>🕘</span> 최근 파일 <em>{files?.length ?? ""}</em>
          </button>
          <button className={tab === "samples" ? "active" : ""} onClick={() => setTab("samples")} disabled={!fixtures.length}>
            <span>📁</span> 샘플 <em>{fixtures.length || ""}</em>
          </button>
        </nav>
        <p className="home-note">파일은 이 브라우저에만 저장됩니다. 다른 곳에서 쓰려면 <b>.fig 다운로드</b>를 사용하세요.</p>
      </aside>

      <main className="home-main">
        <header className="home-header">
          <input className="search" placeholder="파일 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="spacer" />
          <button className="secondary" onClick={() => input.current?.click()}>.fig 가져오기</button>
          <button className="primary" onClick={() => onNew(null)}>＋ 새 디자인 파일</button>
          <input ref={input} type="file" accept=".fig" hidden onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
        </header>

        <section className="home-section">
          <h2>새로 만들기</h2>
          <div className="preset-row">
            <button className="preset blank" onClick={() => onNew(null)}>
              <span className="preset-art"><span className="plus">＋</span></span>
              <b>빈 캔버스</b>
              <small>아트보드 없이 시작</small>
            </button>
            {PRESETS.map((p) => (
              <button key={p.id} className="preset" onClick={() => onNew(p)} title={`${p.label} · ${p.w}×${p.h}`}>
                <span className="preset-art">
                  <span className="board" style={boardStyle(p)} />
                </span>
                <b>{p.label}</b>
                <small>{p.w} × {p.h}</small>
              </button>
            ))}
          </div>
        </section>

        {tab === "recent" ? (
          <section className="home-section">
            <h2>최근 파일</h2>
            {files === null ? null : shownFiles.length === 0 ? (
              <div className="empty-state">
                {q ? "검색 결과가 없습니다." : (
                  <>
                    <p>아직 파일이 없습니다.</p>
                    <p className="muted">위에서 새 파일을 만들거나, .fig 파일을 가져오거나, 이 화면에 끌어다 놓으세요.</p>
                  </>
                )}
              </div>
            ) : (
              <div className="file-grid">
                {shownFiles.map((f) => (
                  <FileCard key={f.id} file={f} onOpen={() => onOpen(f)} onChanged={refresh} />
                ))}
              </div>
            )}
          </section>
        ) : (
          <section className="home-section">
            <h2>샘플 <small className="muted">fixtures/ 폴더 · 열면 최근 파일에 복사본이 생깁니다</small></h2>
            <div className="file-grid">
              {shownFixtures.map((f) => (
                <button key={f.name} className="file-card" onClick={() => onOpenSample(f.name)}>
                  <span className="thumb">
                    <img src={`/__fixtures/${encodeURIComponent(f.name)}/thumbnail`} alt="" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                  </span>
                  <span className="meta">
                    <b>{f.name.replace(/\.fig$/, "")}</b>
                    <small>샘플 · {relativeTime(f.mtime)} · {mb(f.size)}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

/** Artboard silhouette scaled into a 72×52 box. */
function boardStyle(p: Preset): React.CSSProperties {
  const s = Math.min(64 / p.w, 44 / p.h);
  return { width: Math.max(8, p.w * s), height: Math.max(8, p.h * s) };
}

function FileCard({ file, onOpen, onChanged }: { file: LibraryFile; onOpen(): void; onChanged(): void }) {
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const thumb = useMemo(() => (file.thumbnail ? URL.createObjectURL(file.thumbnail) : null), [file.thumbnail]);
  useEffect(() => () => {
    if (thumb) URL.revokeObjectURL(thumb);
  }, [thumb]);

  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(false);
      setConfirmDelete(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  return (
    <div className="file-card" onClick={() => !renaming && onOpen()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <span className="thumb">
        {thumb ? <img src={thumb} alt="" /> : <span className="thumb-empty">{file.origin === "new" ? "새 파일" : ""}</span>}
      </span>
      <span className="meta">
        {renaming ? (
          <input
            autoFocus
            defaultValue={file.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={async (e) => {
              const name = e.target.value.trim();
              setRenaming(false);
              if (name && name !== file.name) {
                await renameFile(file.id, name);
                onChanged();
              }
            }}
          />
        ) : (
          <b>{file.name}</b>
        )}
        <small>편집 {relativeTime(file.updatedAt)} · {mb(file.size)}</small>
      </span>
      <button
        className="more"
        title="더 보기"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setMenu((m) => !m);
        }}
      >
        ⋯
      </button>
      {menu && (
        <div className="menu" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          {confirmDelete ? (
            <>
              <div className="menu-title">“{file.name}”을(를) 삭제할까요?</div>
              <button
                className="danger"
                onClick={async () => {
                  await deleteFile(file.id);
                  setMenu(false);
                  onChanged();
                }}
              >
                삭제
              </button>
              <button onClick={() => setConfirmDelete(false)}>취소</button>
            </>
          ) : (
            <>
              <button onClick={() => { setMenu(false); onOpen(); }}>열기</button>
              <button onClick={() => { setMenu(false); setRenaming(true); }}>이름 바꾸기</button>
              <button
                onClick={async () => {
                  setMenu(false);
                  const bytes = await getBytes(file.id);
                  if (bytes) download(file.name, bytes);
                }}
              >
                .fig 다운로드
              </button>
              <button className="danger" onClick={() => setConfirmDelete(true)}>삭제…</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
