import { useCallback, useEffect, useRef, useState } from "react";
import type { Pt } from "@/lib/hull";

/** Drop consecutive repeats (a double-click's own clicks land on the last
 *  corner) and a last corner that closes back onto the first. */
export function closeVertices(v: Pt[], eps = 1e-9): Pt[] {
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
  const out: Pt[] = [];
  for (const p of v) {
    if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  }
  if (out.length > 1 && same(out[0], out[out.length - 1])) out.pop();
  return out;
}

export interface DrawArea {
  active: boolean;
  vertices: Pt[];
  start: () => void;
  add: (p: Pt) => void;
  finish: () => void;
  cancel: () => void;
}

/** C10: click adds a corner, double-click (or Finish) closes, Esc cancels. No
 *  draw library. ``finish`` with fewer than three distinct corners keeps
 *  drawing. Works in any plane (SVG units or lng/lat). */
export function useDrawArea(onFinish: (ring: Pt[]) => void): DrawArea {
  const [active, setActive] = useState(false);
  const [vertices, setVertices] = useState<Pt[]>([]);
  const verticesRef = useRef<Pt[]>([]);
  const activeRef = useRef(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const setBoth = useCallback((v: Pt[]) => {
    verticesRef.current = v;
    setVertices(v);
  }, []);
  const cancel = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    setBoth([]);
  }, [setBoth]);
  const start = useCallback(() => {
    activeRef.current = true;
    setActive(true);
    setBoth([]);
  }, [setBoth]);
  const add = useCallback(
    (p: Pt) => {
      if (activeRef.current) setBoth([...verticesRef.current, p]);
    },
    [setBoth],
  );
  const finish = useCallback(() => {
    if (!activeRef.current) return;
    const ring = closeVertices(verticesRef.current);
    if (ring.length < 3) return;
    cancel();
    finishRef.current(ring);
  }, [cancel]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, cancel]);

  return { active, vertices, start, add, finish, cancel };
}

/** For a Radix Dialog's ``onEscapeKeyDown``: the dialog catches Esc before the
 *  hook's window listener, so while drawing Esc must cancel the draw and keep
 *  the dialog open (C10). Not drawing → the dialog closes as usual. */
export function drawEscapeHandler(draw: Pick<DrawArea, "active" | "cancel">) {
  return (e: KeyboardEvent) => {
    if (draw.active) {
      e.preventDefault();
      draw.cancel();
    }
  };
}
