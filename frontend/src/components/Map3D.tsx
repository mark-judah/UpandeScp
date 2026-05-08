import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { cn } from "@/lib/utils";

/**
 * MapLibre-GL wrapper used by the 3D map pages (avocado, future rose-3D).
 * Exposes the underlying ``maplibregl.Map`` via ``onReady`` so consumers
 * can attach GeoJSON sources, custom Three.js layers, click handlers, etc.
 *
 * Default style is OpenFreeMap "liberty" — same as the JS avocado_scouts_map
 * page, no API key needed. Pitch defaults to 60° because the canopy mesh
 * looks flat from straight overhead.
 */
export interface Map3DProps {
  className?: string;
  initialCenter?: [number, number];
  initialZoom?: number;
  initialPitch?: number;
  styleUrl?: string;
  onReady: (map: maplibregl.Map) => void;
}

export const DEFAULT_CENTER: [number, number] = [36.756, -1.387];
export const DEFAULT_ZOOM = 14;

export function Map3D({
  className,
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
  initialPitch = 60,
  styleUrl = "https://tiles.openfreemap.org/styles/liberty",
  onReady,
}: Map3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = new maplibregl.Map({
      container: el,
      style: styleUrl,
      center: initialCenter,
      zoom: initialZoom,
      pitch: initialPitch,
      bearing: 0,
      hash: false,
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");
    mapRef.current = map;
    setReady(true);
    onReady(map);
    return () => {
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the canvas in sync with parent resizes (sidebar collapse, layout
  // changes). MapLibre auto-resizes on window changes only.
  useEffect(() => {
    if (!ready) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full h-full min-h-[420px] bg-[var(--sd-bg-soft)]",
        className,
      )}
    />
  );
}
