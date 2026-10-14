/**
 * A small zoom / pan surface. Wheel and trackpad zoom at the cursor, drag to
 * pan, double-click toggles 1x / 2.5x, pinch and drag on touch, +/-/reset
 * buttons. The maths lives in lib/zoom-pan. Children fill the surface.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import {
  BUTTON_STEP, IDENTITY, MAX_ZOOM, MIN_ZOOM, panBy, toggleZoom, wheelFactor, zoomAt,
  type Point, type Size, type View,
} from "@/lib/zoom-pan";
import { cn } from "@/lib/utils";

export function ZoomPan({
  children, className, resetKey, onScale, testId = "zoom-pan",
}: {
  children: ReactNode;
  className?: string;
  /** Changing this resets the view to 1x. */
  resetKey?: string;
  onScale?: (scale: number) => void;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const viewRef = useRef(view);
  const [animate, setAnimate] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ dist: number } | null>(null);
  const dragged = useRef(false);

  const apply = useCallback((v: View, smooth = false) => {
    viewRef.current = v;
    setAnimate(smooth);
    setView(v);
  }, []);
  useEffect(() => { onScale?.(view.scale); }, [view.scale, onScale]);
  useEffect(() => { apply(IDENTITY); }, [resetKey, apply]);

  const sizeOf = (): Size => {
    const r = box.current?.getBoundingClientRect();
    return { w: r?.width || 1, h: r?.height || 1 };
  };
  const rel = (cx: number, cy: number): Point => {
    const r = box.current?.getBoundingClientRect();
    return { x: cx - (r?.left ?? 0), y: cy - (r?.top ?? 0) };
  };
  const centre = (): Point => { const s = sizeOf(); return { x: s.w / 2, y: s.h / 2 }; };

  // Wheel needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      apply(zoomAt(v, rel(e.clientX, e.clientY), v.scale * wheelFactor(e.deltaY, e.ctrlKey), sizeOf()));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply]);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-zoom-ui]")) return;
    pointers.current.set(e.pointerId, rel(e.clientX, e.clientY));
    dragged.current = false;
    try { box.current?.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const now = rel(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, now);
    const size = sizeOf();
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const v = viewRef.current;
      apply(zoomAt(v, mid, v.scale * (dist / pinch.current.dist), size));
      pinch.current.dist = dist;
      dragged.current = true;
    } else if (pointers.current.size === 1) {
      const dx = now.x - prev.x, dy = now.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) dragged.current = true;
      if (viewRef.current.scale > 1) apply(panBy(viewRef.current, dx, dy, size));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const step = (f: number) => apply(zoomAt(viewRef.current, centre(), viewRef.current.scale * f, sizeOf()), true);

  return (
    <div
      ref={box}
      data-testid={testId}
      data-scale={view.scale.toFixed(2)}
      className={cn("relative touch-none select-none overflow-hidden", view.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-zoom-ui]")) return;
        apply(toggleZoom(viewRef.current, rel(e.clientX, e.clientY), sizeOf()), true);
      }}
    >
      <div
        data-testid={`${testId}-content`}
        className={cn("absolute inset-0 origin-top-left will-change-transform", animate && "transition-transform duration-200 ease-out motion-reduce:transition-none")}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        {children}
      </div>
      <div data-zoom-ui className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/60 p-1 text-white backdrop-blur">
        <button type="button" aria-label="Zoom out" disabled={view.scale <= MIN_ZOOM} onClick={() => step(1 / BUTTON_STEP)} className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-30"><Minus className="h-4 w-4" /></button>
        <span className="w-10 text-center text-xs tabular-nums" data-testid={`${testId}-level`}>{view.scale.toFixed(1)}×</span>
        <button type="button" aria-label="Zoom in" disabled={view.scale >= MAX_ZOOM} onClick={() => step(BUTTON_STEP)} className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-30"><Plus className="h-4 w-4" /></button>
        <button type="button" aria-label="Reset zoom" disabled={view.scale === 1} onClick={() => apply(IDENTITY, true)} className="rounded-full p-1.5 hover:bg-white/15 disabled:opacity-30"><RotateCcw className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
