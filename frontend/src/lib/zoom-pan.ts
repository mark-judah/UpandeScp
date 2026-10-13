/**
 * Pure zoom / pan maths for the finding viewer. A view is the transform
 * `translate(x, y) scale(scale)` applied with origin top-left to content that
 * exactly fills its container (size). Points are container-relative pixels.
 */
/** Zoom is relative to "fit": 1x shows the whole content in the stage. */
export const FIT_ZOOM = 1;
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;
export const DOUBLE_ZOOM = 2.5;
export const BUTTON_STEP = 1.5;

export interface View { scale: number; x: number; y: number }
export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

export const IDENTITY: View = { scale: 1, x: 0, y: 0 };

export function clampZoom(z: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(z)) return FIT_ZOOM;
  return Math.min(max, Math.max(min, z));
}

/** Scale that makes content of `natural` size fit entirely inside `stage`
 *  (object-contain). 0 when either size is unknown. */
export function fitScale(natural: Size, stage: Size): number {
  if (!(natural.w > 0 && natural.h > 0 && stage.w > 0 && stage.h > 0)) return 0;
  return Math.min(stage.w / natural.w, stage.h / natural.h);
}

/** Keep the content from being lost: zoomed in, it covers the stage with no
 *  gap past an edge; zoomed out below fit, it stays centred. */
export function clampPan(v: View, size: Size): View {
  const fit = (extent: number, pos: number) =>
    v.scale < 1 ? (extent - extent * v.scale) / 2 : Math.min(0, Math.max(extent - extent * v.scale, pos));
  return { scale: v.scale, x: fit(size.w, v.x), y: fit(size.h, v.y) };
}

/** Zoom to `next` keeping the content under `point` fixed on screen. */
export function zoomAt(v: View, point: Point, next: number, size: Size): View {
  const scale = clampZoom(next);
  const k = scale / v.scale;
  return clampPan({ scale, x: point.x - (point.x - v.x) * k, y: point.y - (point.y - v.y) * k }, size);
}

export function panBy(v: View, dx: number, dy: number, size: Size): View {
  return clampPan({ ...v, x: v.x + dx, y: v.y + dy }, size);
}

/** Double-click: back to fit when zoomed in, else 2.5x at the point. */
export function toggleZoom(v: View, point: Point, size: Size): View {
  return v.scale > 1.01 ? IDENTITY : zoomAt(v, point, DOUBLE_ZOOM, size);
}

/** Scale multiplier for one wheel event (trackpad pinch arrives as ctrl+wheel with small deltas). */
export function wheelFactor(deltaY: number, ctrl = false): number {
  return Math.exp(-deltaY * (ctrl ? 0.01 : 0.0018));
}
