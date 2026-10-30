import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Node, NodeId, Transform, Vec2 } from "@figref/model";
import type { HandleId, ImageSource, Rect, Viewport as View } from "@figref/renderer";
import { applyT, invertT, multiplyT, type Editor } from "./editor/Editor";
import { cssFont, lineHeightPx, measureText } from "./editor/text";
import { useEditor } from "./editor/useEditor";

export interface ViewportHandle {
  zoomToFit(): void;
  zoomTo(id: NodeId): void;
  setZoom(zoom: number): void;
}

interface Props {
  editor: Editor;
  images: Map<string, ImageSource>;
  imagesVersion: number;
  background: string;
  editingText: NodeId | null;
  /** Node to zoom to when the document first shows (else the whole page). */
  initialFocus?: NodeId | null;
  onEditText(id: NodeId | null): void;
  onViewChange(view: View): void;
}

type Gesture =
  | { kind: "pan"; x: number; y: number; view: View }
  | { kind: "move"; from: Vec2; ids: NodeId[]; starts: Map<NodeId, Transform>; moved: boolean; selectOnUp: NodeId | null }
  | { kind: "resize"; id: NodeId; start: Node; handle: HandleId; toLocal: Transform }
  | { kind: "create"; id: NodeId; from: Vec2 }
  | { kind: "marquee"; from: Vec2; scope: NodeId; base: ReadonlySet<NodeId> };

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 256;
const HANDLE_HIT = 7;
const DRAG_THRESHOLD = 3;
const IDENTITY: Transform = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const CURSORS: Record<HandleId, string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(props, ref) {
  const { editor, images, imagesVersion, background, editingText, initialFocus, onEditText, onViewChange } = props;
  const version = useEditor(editor);
  const { renderer, pageId, tool } = editor;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<NodeId | null>(null);
  const [cursor, setCursor] = useState("default");
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const spaceDown = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const downScreen = useRef({ x: 0, y: 0 });

  // Fit requests are state, applied once the element has a size; the latest
  // request wins, so "fit page on load" and "zoom to node" can't race.
  const [fitRequest, setFitRequest] = useState<{ rect: Rect; maxZoom: number } | null>(null);
  const fit = useCallback((rect: Rect | null, maxZoom = 1) => {
    if (rect) setFitRequest({ rect, maxZoom });
  }, []);
  useEffect(() => {
    if (!fitRequest || !size.w || !size.h) return;
    const { rect, maxZoom } = fitRequest;
    const pad = 48;
    const zoom = Math.min(maxZoom, (size.w - pad * 2) / Math.max(rect.w, 1), (size.h - pad * 2) / Math.max(rect.h, 1));
    setView({ zoom, x: size.w / 2 - (rect.x + rect.w / 2) * zoom, y: size.h / 2 - (rect.y + rect.h / 2) * zoom });
    setFitRequest(null);
  }, [fitRequest, size]);

  useImperativeHandle(ref, () => ({
    zoomToFit: () => fit(renderer.pageBounds(pageId)),
    zoomTo: (id) => fit(renderer.bounds(id), 4),
    setZoom: (zoom) =>
      setView((v) => {
        const cx = size.w / 2, cy = size.h / 2;
        return { zoom, x: cx - ((cx - v.x) / v.zoom) * zoom, y: cy - ((cy - v.y) / v.zoom) * zoom };
      }),
  }), [fit, renderer, pageId, size]);

  useEffect(() => {
    const el = canvasRef.current!.parentElement!;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const initialFocusRef = useRef(initialFocus);
  useEffect(() => {
    // Idempotent, so React's dev double-run of effects lands on the same view.
    const focus = initialFocusRef.current;
    if (focus && editor.doc.nodes.has(focus) && editor.node(focus).parentId !== null) fit(renderer.bounds(focus), 4);
    else fit(renderer.pageBounds(pageId));
  }, [renderer, pageId, fit, editor]);

  useEffect(() => onViewChange(view), [view, onViewChange]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const id = requestAnimationFrame(() => {
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer.render(ctx, pageId, view, {
        images, background, hover,
        selection: editor.selection,
        handles: tool === "select" && !editingText,
        marquee,
        hidden: editingText ? new Set([editingText]) : undefined,
      });
    });
    return () => cancelAnimationFrame(id);
  }, [renderer, pageId, view, size, images, imagesVersion, hover, background, version, marquee, editingText, tool, editor]);

  const screen = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const s = screen(e);
    return { x: (s.x - view.x) / view.zoom, y: (s.y - view.y) / view.zoom };
  };

  const handleAt = (sx: number, sy: number): { id: NodeId; handle: HandleId } | null => {
    if (editor.selection.size !== 1 || tool !== "select") return null;
    const [id] = editor.selection;
    const node = editor.doc.nodes.get(id!);
    if (!node || node.locked) return null;
    for (const h of renderer.handlePositions(id!, view)) {
      if (node.type === "LINE" && h.id !== "w" && h.id !== "e") continue;
      if (Math.abs(h.x - sx) <= HANDLE_HIT && Math.abs(h.y - sy) <= HANDLE_HIT) return { id: id!, handle: h.id };
    }
    return null;
  };

  // Wheel: pan; pinch / ctrl / cmd + wheel: zoom at cursor. Needs a non-passive listener.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-e.deltaY * 0.01)));
          return { zoom, x: mx - ((mx - v.x) / v.zoom) * zoom, y: my - ((my - v.y) / v.zoom) * zoom };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !typing(e) && !spaceDown.current) {
        spaceDown.current = true;
        setCursor("grab");
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
        if (!gesture.current) setCursor("default");
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const idleCursor = (sx: number, sy: number) => {
    if (spaceDown.current || tool === "hand") return "grab";
    if (tool !== "select") return "crosshair";
    const h = handleAt(sx, sy);
    return h ? CURSORS[h.handle] : "default";
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // Commit any focused panel input first, then keep the browser from moving
    // focus on mousedown (it would immediately blur an inline text editor we open).
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    e.preventDefault();
    const s = screen(e);
    const p = toWorld(e);
    downScreen.current = s;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.button === 1 || spaceDown.current || tool === "hand") {
      gesture.current = { kind: "pan", x: e.clientX, y: e.clientY, view };
      setCursor("grabbing");
      return;
    }
    if (e.button !== 0) return;

    if (tool === "text") {
      editor.checkpoint();
      const id = editor.create("text", p, p);
      editor.commit();
      editor.setTool("select");
      onEditText(id);
      return;
    }
    if (tool !== "select") {
      editor.checkpoint();
      const id = editor.create(tool, p, p, e.shiftKey);
      editor.preview();
      gesture.current = { kind: "create", id, from: p };
      return;
    }

    const h = handleAt(s.x, s.y);
    if (h) {
      const start = editor.beginResize(h.id);
      const parent = start.parentId ? editor.world(start.parentId) : IDENTITY;
      gesture.current = { kind: "resize", id: h.id, start, handle: h.handle, toLocal: invertT(multiplyT(parent, start.transform)) };
      return;
    }

    const label = renderer.frameLabelAt(s.x, s.y);
    let hit = label ?? editor.pick(p.x, p.y, e.metaKey || e.ctrlKey ? "deep" : "click");
    // Dragging on the empty body of a top-level frame with children rubber-bands its children
    // (the frame itself moves by its name label, as in common design tools).
    const scope =
      !label && hit && editor.node(hit).parentId === pageId && renderer.childrenOf(hit).length > 0 && renderer.hitPath(pageId, p.x, p.y).length === 1
        ? hit : null;
    if (scope) hit = null;

    if (!hit) {
      gesture.current = { kind: "marquee", from: p, scope: scope ?? pageId, base: e.shiftKey ? editor.selection : new Set() };
      if (!e.shiftKey) editor.select(scope ? [scope] : []);
      return;
    }

    let selectOnUp: NodeId | null = null;
    if (e.shiftKey) {
      const next = new Set(editor.selection);
      next.has(hit) ? next.delete(hit) : next.add(hit);
      editor.select(next);
    } else if (!editor.selection.has(hit)) {
      editor.select([hit]);
    } else if (editor.selection.size > 1) {
      selectOnUp = hit; // a click (no drag) on one of several selected nodes selects just it
    }
    const ids = [...editor.selection].filter((id) => !editor.node(id).locked);
    gesture.current = { kind: "move", from: p, ids, starts: new Map(ids.map((id) => [id, editor.node(id).transform])), moved: false, selectOnUp };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    const s = screen(e);
    const p = toWorld(e);
    if (!g) {
      setCursor(idleCursor(s.x, s.y));
      setHover(tool === "select" ? editor.pick(p.x, p.y, e.metaKey || e.ctrlKey ? "deep" : "click") : null);
      return;
    }
    switch (g.kind) {
      case "pan":
        setView({ ...g.view, x: g.view.x + e.clientX - g.x, y: g.view.y + e.clientY - g.y });
        return;
      case "move": {
        if (!g.moved) {
          if (Math.hypot(s.x - downScreen.current.x, s.y - downScreen.current.y) < DRAG_THRESHOLD) return;
          g.moved = true;
          editor.checkpoint();
        }
        let dx = p.x - g.from.x, dy = p.y - g.from.y;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
        editor.translate(g.ids, g.starts, dx, dy);
        editor.preview();
        return;
      }
      case "resize":
        editor.resizeFromHandle(g.id, g.start, g.handle, applyT(g.toLocal, p.x, p.y), e.shiftKey);
        editor.preview();
        return;
      case "create":
        editor.resizeCreated(g.id, g.from, p, e.shiftKey);
        editor.preview();
        return;
      case "marquee": {
        const r = { x: Math.min(g.from.x, p.x), y: Math.min(g.from.y, p.y), w: Math.abs(p.x - g.from.x), h: Math.abs(p.y - g.from.y) };
        setMarquee(r);
        editor.select([...g.base, ...editor.nodesInRect(r, g.scope)]);
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toWorld(e);
    const s = screen(e);
    switch (g.kind) {
      case "pan":
        setCursor(spaceDown.current || tool === "hand" ? "grab" : "default");
        return;
      case "move":
        if (g.moved) {
          editor.dropInto(g.ids, p.x, p.y);
          editor.commit();
        } else if (g.selectOnUp) {
          editor.select([g.selectOnUp]);
        }
        return;
      case "resize":
        editor.commit();
        return;
      case "create":
        // A click without a drag makes a default-size shape.
        if (Math.hypot(s.x - downScreen.current.x, s.y - downScreen.current.y) < DRAG_THRESHOLD) {
          const line = editor.node(g.id).type === "LINE";
          editor.resizeCreated(g.id, g.from, { x: g.from.x + 100, y: g.from.y + (line ? 0 : 100) }, false);
        }
        editor.commit();
        editor.setTool("select");
        return;
      case "marquee":
        setMarquee(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool !== "select") return;
    const p = toWorld(e);
    const [sel] = editor.selection;
    if (sel && editor.selection.size === 1 && editor.node(sel).type === "TEXT" && editor.pick(p.x, p.y, "deep") === sel) {
      onEditText(sel);
      return;
    }
    const hit = editor.pick(p.x, p.y, "enter");
    if (hit) {
      editor.select([hit]);
      if (editor.node(hit).type === "TEXT") onEditText(hit);
    }
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="viewport"
        style={{ width: size.w, height: size.h, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      />
      {editingText && editor.doc.nodes.has(editingText) && (
        <TextOverlay key={editingText} editor={editor} id={editingText} view={view} onDone={() => onEditText(null)} />
      )}
    </>
  );
});

/** In-place text editing: a textarea over the text node, committed on blur / Escape / ⌘Enter. */
function TextOverlay({ editor, id, view, onDone }: { editor: Editor; id: NodeId; view: View; onDone(): void }) {
  const node = editor.node(id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(node.text?.characters ?? "");
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    if (done.current) return;
    done.current = true;
    const n = editor.doc.nodes.get(id);
    if (n?.text) {
      if (!value.trim()) {
        // Empty text is discarded, like design tools do.
        editor.select([id]);
        editor.deleteSelection();
      } else if (value !== n.text.characters) {
        editor.transact(() => {
          editor.update(id, { text: { ...n.text!, characters: value } });
          editor.fitText(id, measureText);
        });
      }
    }
    onDone();
  };

  if (!node.text) return null;
  const t = editor.world(id);
  const style = node.text.style;
  const fill = node.fills.find((f) => f.type === "SOLID" && f.visible);
  const color = fill && fill.type === "SOLID" ? `rgb(${fill.color.r * 255}, ${fill.color.g * 255}, ${fill.color.b * 255})` : "#000";
  const measured = measureText(value || " ", style);

  return (
    <textarea
      ref={ref}
      className="text-overlay"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          commit();
        }
      }}
      style={{
        left: t.m02 * view.zoom + view.x,
        top: t.m12 * view.zoom + view.y,
        width: Math.max(measured.w, node.size.x) * view.zoom + 8,
        height: Math.max(measured.h, node.size.y) * view.zoom + 4,
        transform: `rotate(${Math.atan2(t.m10, t.m00)}rad)`,
        transformOrigin: "0 0",
        font: cssFont(style, view.zoom),
        lineHeight: `${lineHeightPx(style) * view.zoom}px`,
        textAlign: style.textAlignHorizontal === "JUSTIFIED" ? "justify" : (style.textAlignHorizontal.toLowerCase() as "left"),
        color,
      }}
    />
  );
}
