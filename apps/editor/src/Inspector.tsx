import { useEffect, useState } from "react";
import type { Color, Effect, Node, Paint, TextStyle } from "@figref/model";
import { rgba } from "@figref/renderer";
import type { Editor } from "./editor/Editor";
import { measureText } from "./editor/text";
import { useEditor } from "./editor/useEditor";

const round = (v: number) => Math.round(v * 100) / 100;

function hexOf(c: Color): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function fromHex(hex: string, a: number): Color {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
}

/** Text field that commits a number on Enter / blur; ↑/↓ step by 1 (Shift: 10). */
function NumberField({ label, value, onCommit, suffix, min }: { label: string; value: number; onCommit(v: number): void; suffix?: string; min?: number }) {
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  const commit = (raw: string) => {
    const v = Number(raw.replace(suffix ?? "", "").trim());
    if (Number.isFinite(v) && v !== round(value)) onCommit(min !== undefined ? Math.max(min, v) : v);
    else setText(String(round(value)));
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
            commit(String(round(value) + step));
          }
          if (e.key === "Escape") {
            setText(String(round(value)));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}

function PaintEditor({ paint, onChange, onRemove }: { paint: Paint; onChange(p: Paint): void; onRemove(): void }) {
  let swatch = "transparent";
  let label: React.ReactNode = paint.type;
  if (paint.type === "SOLID") {
    swatch = rgba(paint.color, paint.opacity);
    label = (
      <>
        <input type="color" value={hexOf(paint.color)} onChange={(e) => onChange({ ...paint, color: fromHex(e.target.value, paint.color.a) })} />
        <code>{hexOf(paint.color).toUpperCase()}</code>
      </>
    );
  } else if ("stops" in paint) {
    swatch = `linear-gradient(90deg, ${paint.stops.map((s) => `${rgba(s.color)} ${s.position * 100}%`).join(", ")})`;
    label = paint.type.replace("GRADIENT_", "그라디언트 ").toLowerCase();
  } else if (paint.type === "IMAGE") {
    label = `이미지 · ${paint.scaleMode}`;
  }
  return (
    <div className={`paint${paint.visible ? "" : " hidden"}`}>
      {paint.type !== "SOLID" && <span className="swatch" style={{ background: swatch }} />}
      <span className="paint-label">{label}</span>
      <input
        className="pct"
        value={Math.round(paint.opacity * 100)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange({ ...paint, opacity: Math.max(0, Math.min(100, v)) / 100 });
        }}
      />
      <span className="muted">%</span>
      <button className="icon-btn" title={paint.visible ? "숨기기" : "보이기"} onClick={() => onChange({ ...paint, visible: !paint.visible })}>
        {paint.visible ? "◉" : "○"}
      </button>
      <button className="icon-btn" title="삭제" onClick={onRemove}>−</button>
    </div>
  );
}

const SOLID = (c: Color): Paint => ({ type: "SOLID", color: c, opacity: 1, visible: true, blendMode: "NORMAL" });
const SHADOW: Effect = { type: "DROP_SHADOW", visible: true, radius: 4, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, spread: 0, blendMode: "NORMAL" };
const EFFECT_LABEL: Record<Effect["type"], string> = {
  DROP_SHADOW: "드롭 섀도", INNER_SHADOW: "이너 섀도", FOREGROUND_BLUR: "레이어 블러", BACKGROUND_BLUR: "배경 블러", UNKNOWN: "기타 효과",
};

export function Inspector({ editor, fileInfo }: { editor: Editor; fileInfo: string }) {
  useEditor(editor);
  const ids = [...editor.selection];
  const node = ids.length === 1 ? editor.doc.nodes.get(ids[0]!) : undefined;

  if (!ids.length) {
    return (
      <aside className="panel right">
        <section>
          <h3>파일</h3>
          <pre className="info">{fileInfo}</pre>
        </section>
        <section className="hint">
          <h3>단축키</h3>
          <p>V 선택 · F 프레임 · R 사각형 · O 원 · L 선 · T 텍스트 · H 손</p>
          <p>⌘Z / ⇧⌘Z 실행 취소/다시 · ⌘D 복제 · ⌘C/⌘V 복사/붙여넣기</p>
          <p>⌘G 그룹 · ⇧⌘G 그룹 해제 · ⌫ 삭제 · 방향키 이동(⇧ 10px)</p>
          <p>⌘] / ⌘[ 앞으로/뒤로 · ⌥⌘] / ⌥⌘[ 맨 앞/맨 뒤</p>
          <p>더블클릭: 그룹 안으로 / 텍스트 편집 · ⌘클릭: 가장 안쪽 선택</p>
          <p>Enter: 자식 선택 · ⇧Enter: 부모 선택 · ⌘S 저장</p>
        </section>
      </aside>
    );
  }

  if (!node) {
    return (
      <aside className="panel right">
        <section>
          <h3>{ids.length}개 선택됨</h3>
          <div className="row-buttons">
            <button onClick={() => editor.group()}>그룹 (⌘G)</button>
            <button onClick={() => editor.duplicate()}>복제</button>
            <button onClick={() => editor.deleteSelection()}>삭제</button>
          </div>
        </section>
      </aside>
    );
  }

  const set = (patch: Partial<Node>) => editor.transact(() => editor.update(node.id, patch));
  const setText = (style: Partial<TextStyle>) =>
    editor.transact(() => {
      editor.update(node.id, { text: { ...node.text!, style: { ...node.text!.style, ...style } } });
      editor.fitText(node.id, measureText);
    });
  const rotation = round((-Math.atan2(node.transform.m10, node.transform.m00) * 180) / Math.PI);
  const isText = node.type === "TEXT";
  const hasCorners = ["ROUNDED_RECTANGLE", "RECTANGLE", "FRAME", "SYMBOL", "INSTANCE"].includes(node.type);

  return (
    <aside className="panel right">
      <section>
        <h3>{node.type}</h3>
        <input
          key={node.id}
          className="name-input"
          defaultValue={node.name}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          onBlur={(e) => e.target.value !== node.name && editor.rename(node.id, e.target.value)}
        />
        <small className="muted">{node.id}</small>
      </section>

      <section>
        <h3>레이아웃</h3>
        <div className="fields">
          <NumberField label="X" value={node.transform.m02} onCommit={(v) => editor.transact(() => editor.setPosition(node.id, v, node.transform.m12))} />
          <NumberField label="Y" value={node.transform.m12} onCommit={(v) => editor.transact(() => editor.setPosition(node.id, node.transform.m02, v))} />
          <NumberField label="W" value={node.size.x} min={0.01} onCommit={(v) => editor.transact(() => editor.setSize(node.id, v, node.size.y))} />
          {node.type !== "LINE" && <NumberField label="H" value={node.size.y} min={0.01} onCommit={(v) => editor.transact(() => editor.setSize(node.id, node.size.x, v))} />}
          <NumberField label="회전" value={rotation} suffix="°" onCommit={(v) => editor.transact(() => editor.setRotation(node.id, v))} />
          {hasCorners && <NumberField label="모서리" value={node.cornerRadius} min={0} onCommit={(v) => set({ cornerRadius: v })} />}
        </div>
        {["FRAME", "SYMBOL", "INSTANCE"].includes(node.type) && (
          <label className="check">
            <input type="checkbox" checked={node.clipsContent} onChange={(e) => set({ clipsContent: e.target.checked })} /> 내용 자르기
          </label>
        )}
      </section>

      <section>
        <h3>레이어</h3>
        <div className="fields">
          <NumberField label="불투명도" value={Math.round(node.opacity * 100)} suffix="%" min={0} onCommit={(v) => set({ opacity: Math.min(100, v) / 100 })} />
          <label className="field">
            <span>블렌드</span>
            <select value={node.blendMode} onChange={(e) => set({ blendMode: e.target.value as Node["blendMode"] })}>
              {["PASS_THROUGH", "NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"].map((m) => (
                <option key={m} value={m}>{m.toLowerCase().replace("_", " ")}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {isText && node.text && (
        <section>
          <h3>텍스트</h3>
          <div className="muted">{node.text.style.fontFamily} · {node.text.style.fontStyle}</div>
          <div className="fields">
            <NumberField label="크기" value={node.text.style.fontSize} min={1} onCommit={(v) => setText({ fontSize: v })} />
            <label className="field">
              <span>정렬</span>
              <select value={node.text.style.textAlignHorizontal} onChange={(e) => setText({ textAlignHorizontal: e.target.value as TextStyle["textAlignHorizontal"] })}>
                <option value="LEFT">왼쪽</option><option value="CENTER">가운데</option><option value="RIGHT">오른쪽</option><option value="JUSTIFIED">양쪽</option>
              </select>
            </label>
          </div>
          <small className="muted">{node.textLayout ? `저장된 글리프 ${node.textLayout.glyphs.length}개로 표시 중 (편집하면 글꼴로 다시 그림)` : "글꼴로 표시 중"}</small>
        </section>
      )}

      <section>
        <h3>
          채우기
          <button className="icon-btn right" title="채우기 추가" onClick={() => set({ fills: [...node.fills, SOLID({ r: 0.85, g: 0.85, b: 0.85, a: 1 })] })}>+</button>
        </h3>
        {node.fills.map((p, i) => (
          <PaintEditor
            key={i}
            paint={p}
            onChange={(np) => set({ fills: node.fills.map((x, j) => (j === i ? np : x)) })}
            onRemove={() => set({ fills: node.fills.filter((_, j) => j !== i) })}
          />
        ))}
      </section>

      <section>
        <h3>
          선
          <button className="icon-btn right" title="선 추가" onClick={() => set({ strokes: [...node.strokes, SOLID({ r: 0, g: 0, b: 0, a: 1 })], strokeWeight: node.strokeWeight || 1 })}>+</button>
        </h3>
        {node.strokes.map((p, i) => (
          <PaintEditor
            key={i}
            paint={p}
            onChange={(np) => set({ strokes: node.strokes.map((x, j) => (j === i ? np : x)) })}
            onRemove={() => set({ strokes: node.strokes.filter((_, j) => j !== i) })}
          />
        ))}
        {node.strokes.length > 0 && (
          <div className="fields">
            <NumberField label="두께" value={node.strokeWeight} min={0} onCommit={(v) => set({ strokeWeight: v })} />
            <label className="field">
              <span>위치</span>
              <select value={node.strokeAlign} onChange={(e) => set({ strokeAlign: e.target.value as Node["strokeAlign"] })}>
                <option value="INSIDE">안쪽</option><option value="CENTER">가운데</option><option value="OUTSIDE">바깥쪽</option>
              </select>
            </label>
          </div>
        )}
      </section>

      <section>
        <h3>
          효과
          <button className="icon-btn right" title="드롭 섀도 추가" onClick={() => set({ effects: [...node.effects, SHADOW] })}>+</button>
        </h3>
        {node.effects.map((fx, i) => (
          <div key={i} className={`paint${fx.visible ? "" : " hidden"}`}>
            <span className="paint-label">{EFFECT_LABEL[fx.type]}</span>
            {fx.type.endsWith("SHADOW") && <small className="muted">x {fx.offset.x} · y {fx.offset.y} · blur {fx.radius}</small>}
            <button className="icon-btn" onClick={() => set({ effects: node.effects.map((x, j) => (j === i ? { ...x, visible: !x.visible } : x)) })}>
              {fx.visible ? "◉" : "○"}
            </button>
            <button className="icon-btn" onClick={() => set({ effects: node.effects.filter((_, j) => j !== i) })}>−</button>
          </div>
        ))}
      </section>

      <section>
        <h3>원본 데이터</h3>
        <small className="muted">{node.raw ? `NodeChange 필드 ${Object.keys(node.raw).length}개 보존 중` : "새로 만든 노드"}</small>
      </section>
    </aside>
  );
}

