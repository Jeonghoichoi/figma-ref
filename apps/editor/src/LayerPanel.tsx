import { useState } from "react";
import type { Node, NodeId } from "@figref/model";
import type { Editor } from "./editor/Editor";
import { useEditor } from "./editor/useEditor";

const ICONS: Partial<Record<Node["type"], string>> = {
  FRAME: "#", GROUP: "▢", SECTION: "§", RECTANGLE: "□", ROUNDED_RECTANGLE: "□", ELLIPSE: "○", LINE: "╱",
  STAR: "☆", REGULAR_POLYGON: "△", VECTOR: "✎", BOOLEAN_OPERATION: "◑", TEXT: "T", SYMBOL: "❖", INSTANCE: "◇",
};
const CONTAINERS = new Set<Node["type"]>(["FRAME", "GROUP", "SYMBOL", "INSTANCE", "SECTION", "BOOLEAN_OPERATION"]);

type Drop = { id: NodeId; where: "above" | "below" | "inside" };

interface Props {
  editor: Editor;
  onFocus(id: NodeId): void;
}

export function LayerPanel({ editor, onFocus }: Props) {
  useEditor(editor);
  const { renderer, pageId, selection } = editor;
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());
  const [renaming, setRenaming] = useState<NodeId | null>(null);
  const [dragging, setDragging] = useState<NodeId | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);

  const toggle = (id: NodeId) =>
    setCollapsed((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const select = (id: NodeId, e: React.MouseEvent) => {
    if (e.shiftKey || e.metaKey) {
      const next = new Set(selection);
      next.has(id) ? next.delete(id) : next.add(id);
      editor.select(next);
    } else {
      editor.select([id]);
    }
  };

  // The panel lists front-most first; tree indices count from the back.
  const applyDrop = (d: Drop) => {
    if (!dragging || dragging === d.id) return;
    const target = editor.node(d.id);
    if (d.where === "inside") {
      editor.moveInTree(dragging, d.id, Infinity);
      return;
    }
    const siblings = renderer.childrenOf(target.parentId!).filter((n) => n.id !== dragging);
    const i = siblings.findIndex((n) => n.id === d.id);
    editor.moveInTree(dragging, target.parentId!, d.where === "above" ? i + 1 : i);
  };

  const rows: JSX.Element[] = [];
  const walk = (node: Node, depth: number) => {
    const kids = renderer.childrenOf(node.id);
    const open = !collapsed.has(node.id);
    const dropClass = drop?.id === node.id ? ` drop-${drop.where}` : "";
    rows.push(
      <div
        key={node.id}
        className={`layer${selection.has(node.id) ? " selected" : ""}${node.visible ? "" : " hidden"}${node.locked ? " locked" : ""}${dropClass}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={renaming !== node.id}
        onDragStart={(e) => {
          setDragging(node.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!dragging || dragging === node.id) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const f = (e.clientY - r.top) / r.height;
          const where = CONTAINERS.has(node.type) && f > 0.3 && f < 0.7 ? "inside" : f < 0.5 ? "above" : "below";
          setDrop({ id: node.id, where });
        }}
        onDragLeave={() => setDrop((d) => (d?.id === node.id ? null : d))}
        onDrop={(e) => {
          e.preventDefault();
          if (drop) applyDrop(drop);
          setDrop(null);
          setDragging(null);
        }}
        onDragEnd={() => {
          setDrop(null);
          setDragging(null);
        }}
        onClick={(e) => select(node.id, e)}
        onDoubleClick={() => setRenaming(node.id)}
        title={`${node.type} · ${node.id} — 더블클릭: 이름 바꾸기`}
      >
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            toggle(node.id);
          }}
        >
          {kids.length ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="icon">{ICONS[node.type] ?? "?"}</span>
        {renaming === node.id ? (
          <input
            className="rename"
            autoFocus
            defaultValue={node.name}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={(e) => {
              if (renaming && e.target.value !== node.name) editor.rename(node.id, e.target.value);
              setRenaming(null);
            }}
          />
        ) : (
          <span className="name">{node.name || node.type}</span>
        )}
        <span className="row-actions">
          <button className="icon-btn" title="이 위치로 이동" onClick={(e) => { e.stopPropagation(); onFocus(node.id); }}>⌖</button>
          <button className={`icon-btn${node.locked ? " on" : ""}`} title={node.locked ? "잠금 해제" : "잠금"} onClick={(e) => { e.stopPropagation(); editor.toggle(node.id, "locked"); }}>
            {node.locked ? "🔒" : "🔓"}
          </button>
          <button className={`icon-btn${node.visible ? "" : " on"}`} title={node.visible ? "숨기기" : "보이기"} onClick={(e) => { e.stopPropagation(); editor.toggle(node.id, "visible"); }}>
            {node.visible ? "◉" : "○"}
          </button>
        </span>
      </div>,
    );
    if (open) for (let i = kids.length - 1; i >= 0; i--) walk(kids[i]!, depth + 1);
  };
  const top = renderer.childrenOf(pageId);
  for (let i = top.length - 1; i >= 0; i--) walk(top[i]!, 0);

  return (
    <aside className="panel left">
      <section>
        <h3>페이지</h3>
        {editor.pages().map((p) => (
          <div key={p.id} className={`page${p.id === pageId ? " selected" : ""}`} onClick={() => editor.setPage(p.id)}>
            {p.name}
          </div>
        ))}
      </section>
      <section className="layers">
        <h3>레이어 <span className="count">{editor.doc.nodes.size}</span></h3>
        <div className="tree" onClick={(e) => e.target === e.currentTarget && editor.select([])}>{rows}</div>
      </section>
    </aside>
  );
}
