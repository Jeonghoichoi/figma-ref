import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import type { NodeId } from "@figref/model";
import type { ImageSource, Renderer, Viewport as View } from "@figref/renderer";

export interface ViewportHandle {
  zoomToFit(): void;
  zoomTo(id: NodeId): void;
  setZoom(zoom: number): void;
}

interface Props {
  renderer: Renderer;
  pageId: NodeId;
  images: Map<string, ImageSource>;
  imagesVersion: number;
  background: string;
  selection: ReadonlySet<NodeId>;
  hover: NodeId | null;
  onSelect(id: NodeId | null, additive: boolean): void;
  onHover(id: NodeId | null): void;
  onViewChange(view: View): void;
}

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 256;

export const Viewport = forwardRef<ViewportHandle, Props>(function Viewport(props, ref) {
  const { renderer, pageId, images, imagesVersion, background, selection, hover, onSelect, onHover, onViewChange } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [panning, setPanning] = useState(false);
  const spaceDown = useRef(false);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  // A fit requested before the element has a size (e.g. right after load) runs once it does.
  const pendingFit = useRef<{ rect: { x: number; y: number; w: number; h: number }; maxZoom: number } | null>(null);
  const fit = useCallback(
    (rect: { x: number; y: number; w: number; h: number } | null, maxZoom = 1) => {
      if (!rect) return;
      if (!size.w || !size.h) {
        pendingFit.current = { rect, maxZoom };
        return;
      }
      const pad = 48;
      const zoom = Math.min(maxZoom, (size.w - pad * 2) / Math.max(rect.w, 1), (size.h - pad * 2) / Math.max(rect.h, 1));
      setView({ zoom, x: size.w / 2 - (rect.x + rect.w / 2) * zoom, y: size.h / 2 - (rect.y + rect.h / 2) * zoom });
    },
    [size],
  );

  useImperativeHandle(ref, () => ({
    zoomToFit: () => fit(renderer.pageBounds(pageId)),
    zoomTo: (id) => fit(renderer.bounds(id), 4),
    setZoom: (zoom) =>
      setView((v) => {
        const cx = size.w / 2, cy = size.h / 2;
        return { zoom, x: cx - ((cx - v.x) / v.zoom) * zoom, y: cy - ((cy - v.y) / v.zoom) * zoom };
      }),
  }), [fit, renderer, pageId, size]);

  // Track element size.
  useEffect(() => {
    const el = canvasRef.current!.parentElement!;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the page when it (or the document) changes.
  useEffect(() => {
    const pending = pendingFit.current;
    pendingFit.current = null;
    if (pending) fit(pending.rect, pending.maxZoom);
    else fit(renderer.pageBounds(pageId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, pageId, size.w > 0]);

  useEffect(() => onViewChange(view), [view, onViewChange]);

  // Draw (coalesced to one frame).
  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const id = requestAnimationFrame(() => {
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer.render(ctx, pageId, view, { images, selection, hover, background });
    });
    return () => cancelAnimationFrame(id);
  }, [renderer, pageId, view, size, images, imagesVersion, selection, hover, background]);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.zoom, y: (e.clientY - r.top - view.y) / view.zoom };
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
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) {
        spaceDown.current = true;
        setPanning(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = false;
        if (!drag.current) setPanning(false);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="viewport"
      style={{ width: size.w, height: size.h, cursor: panning ? (drag.current ? "grabbing" : "grab") : "default" }}
      onPointerDown={(e) => {
        if (e.button === 1 || spaceDown.current) {
          drag.current = { x: e.clientX, y: e.clientY, view };
          setPanning(true);
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
        if (e.button === 0) {
          const p = toWorld(e);
          onSelect(renderer.hitTest(pageId, p.x, p.y), e.shiftKey);
        }
      }}
      onPointerMove={(e) => {
        if (drag.current) {
          const d = drag.current;
          setView({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y });
          return;
        }
        const p = toWorld(e);
        onHover(renderer.hitTest(pageId, p.x, p.y));
      }}
      onPointerUp={() => {
        if (drag.current) {
          drag.current = null;
          setPanning(spaceDown.current);
        }
      }}
      onPointerLeave={() => onHover(null)}
    />
  );
});
