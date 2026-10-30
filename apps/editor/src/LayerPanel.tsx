import { useState } from "react";
import type { Document, Node, NodeId } from "@figref/model";
import type { Renderer } from "@figref/renderer";

const ICONS: Partial<Record<Node["type"], string>> = {
  FRAME: "#", GROUP: "▢", SECTION: "§", RECTANGLE: "□", ROUNDED_RECTANGLE: "□", ELLIPSE: "○", LINE: "╱",
  STAR: "☆", REGULAR_POLYGON: "△", VECTOR: "✎", BOOLEAN_OPERATION: "◑", TEXT: "T", SYMBOL: "❖", INSTANCE: "◇",
};

interface Props {
  doc: Document;
  renderer: Renderer;
  pages: Node[];
  pageId: NodeId;
  selection: ReadonlySet<NodeId>;
  hover: NodeId | null;
  onPage(id: NodeId): void;
  onSelect(id: NodeId, additive: boolean): void;
  onHover(id: NodeId | null): void;
  onFocus(id: NodeId): void;
}

export function LayerPanel({ doc, renderer, pages, pageId, selection, hover, onPage, onSelect, onHover, onFocus }: Props) {
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());

  const toggle = (id: NodeId) =>
    setCollapsed((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const rows: JSX.Element[] = [];
  const walk = (node: Node, depth: number) => {
    const kids = renderer.childrenOf(node.id);
    const open = !collapsed.has(node.id);
    rows.push(
      <div
        key={node.id}
        className={`layer${selection.has(node.id) ? " selected" : ""}${hover === node.id ? " hover" : ""}${node.visible ? "" : " hidden"}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={(e) => onSelect(node.id, e.shiftKey)}
        onDoubleClick={() => onFocus(node.id)}
        onMouseEnter={() => onHover(node.id)}
        onMouseLeave={() => onHover(null)}
        title={`${node.type} · ${node.id}`}
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
        <span className="name">{node.name || node.type}</span>
      </div>,
    );
    if (open) for (let i = kids.length - 1; i >= 0; i--) walk(kids[i]!, depth + 1); // front-most first, like design tools
  };
  const top = renderer.childrenOf(pageId);
  for (let i = top.length - 1; i >= 0; i--) walk(top[i]!, 0);

  return (
    <aside className="panel left">
      <section>
        <h3>페이지</h3>
        {pages.map((p) => (
          <div key={p.id} className={`page${p.id === pageId ? " selected" : ""}`} onClick={() => onPage(p.id)}>
            {p.name}
          </div>
        ))}
      </section>
      <section className="layers">
        <h3>레이어 <span className="count">{doc.nodes.size}</span></h3>
        <div className="tree">{rows}</div>
      </section>
    </aside>
  );
}
