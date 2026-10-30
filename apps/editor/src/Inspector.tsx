import type { Color, Document, Effect, NodeId, Paint } from "@figref/model";
import { rgba, type Renderer } from "@figref/renderer";

function hexOf(c: Color): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

const round = (v: number) => Math.round(v * 100) / 100;

function PaintRow({ p }: { p: Paint }) {
  let swatch = "transparent";
  let label: string = p.type;
  if (p.type === "SOLID") {
    swatch = rgba(p.color, p.opacity);
    label = `${hexOf(p.color)}  ${Math.round(p.color.a * p.opacity * 100)}%`;
  } else if (p.type.startsWith("GRADIENT") && "stops" in p) {
    swatch = `linear-gradient(90deg, ${p.stops.map((s) => `${rgba(s.color)} ${s.position * 100}%`).join(", ")})`;
    label = p.type.replace("GRADIENT_", "그라디언트 ").toLowerCase();
  } else if (p.type === "IMAGE") {
    label = `이미지 · ${p.scaleMode} · ${p.imageHash.slice(0, 8)}…`;
  }
  return (
    <div className={`paint${p.visible ? "" : " hidden"}`}>
      <span className="swatch" style={{ background: swatch }} />
      <span>{label}</span>
    </div>
  );
}

function EffectRow({ e }: { e: Effect }) {
  const detail = e.type.endsWith("SHADOW") ? `x ${e.offset.x} · y ${e.offset.y} · blur ${e.radius} · ${hexOf(e.color)} ${Math.round(e.color.a * 100)}%` : `blur ${e.radius}`;
  return <div className={`paint${e.visible ? "" : " hidden"}`}>{e.type} <small>{detail}</small></div>;
}

export function Inspector({ doc, renderer, selection, fileInfo }: { doc: Document; renderer: Renderer; selection: ReadonlySet<NodeId>; fileInfo: string }) {
  const [id] = selection;
  const node = id ? doc.nodes.get(id) : undefined;

  if (!node) {
    return (
      <aside className="panel right">
        <section>
          <h3>파일</h3>
          <pre className="info">{fileInfo}</pre>
        </section>
        <section className="hint">
          <h3>조작</h3>
          <p>스크롤: 이동 · ⌘/Ctrl+스크롤 또는 핀치: 확대/축소</p>
          <p>Space+드래그: 이동 · Shift+1: 전체 보기 · Shift+0: 100%</p>
          <p>클릭: 선택 · 레이어 더블클릭: 해당 위치로</p>
        </section>
      </aside>
    );
  }

  const b = renderer.bounds(node.id);
  const rotation = round((-Math.atan2(node.transform.m10, node.transform.m00) * 180) / Math.PI);
  const unmapped = node.raw ? Object.keys(node.raw).length : 0;

  return (
    <aside className="panel right">
      <section>
        <h3>{node.type}</h3>
        <div className="title">{node.name}</div>
        <small className="muted">{node.id}{selection.size > 1 ? ` 외 ${selection.size - 1}개` : ""}</small>
      </section>
      <section>
        <h3>레이아웃</h3>
        <div className="grid">
          <label>X</label><span>{round(b.x)}</span><label>Y</label><span>{round(b.y)}</span>
          <label>W</label><span>{round(node.size.x)}</span><label>H</label><span>{round(node.size.y)}</span>
          <label>회전</label><span>{rotation}°</span><label>모서리</label><span>{round(node.cornerRadius)}</span>
          <label>불투명도</label><span>{Math.round(node.opacity * 100)}%</span><label>클립</label><span>{node.clipsContent ? "예" : "아니요"}</span>
        </div>
      </section>
      {node.text && (
        <section>
          <h3>텍스트</h3>
          <div>{node.text.style.fontFamily} · {node.text.style.fontStyle} · {round(node.text.style.fontSize)}px</div>
          <p className="chars">{node.text.characters}</p>
          <small className="muted">{node.textLayout ? `저장된 글리프 ${node.textLayout.glyphs.length}개로 렌더링` : "글꼴로 렌더링"}</small>
        </section>
      )}
      {node.fills.length > 0 && <section><h3>채우기</h3>{node.fills.map((p, i) => <PaintRow key={i} p={p} />)}</section>}
      {node.strokes.length > 0 && (
        <section>
          <h3>선 <small>{round(node.strokeWeight)} · {node.strokeAlign}</small></h3>
          {node.strokes.map((p, i) => <PaintRow key={i} p={p} />)}
        </section>
      )}
      {node.effects.length > 0 && <section><h3>효과</h3>{node.effects.map((e, i) => <EffectRow key={i} e={e} />)}</section>}
      <section>
        <h3>원본 데이터</h3>
        <small className="muted">NodeChange 필드 {unmapped}개 보존 중</small>
      </section>
    </aside>
  );
}
