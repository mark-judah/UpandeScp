import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";

/**
 * Shared leaflet base map.
 *
 * Renders an OSM tile layer in a sized div and exposes the underlying
 * ``L.Map`` instance via the ``onReady`` callback so consumers can add
 * their own layers (markers, GeoJSON, heat overlays). Resize events are
 * handled internally with a ResizeObserver — Leaflet otherwise paints
 * incomplete tiles when the map's container changes size.
 *
 * The default centre falls back to Karen Roses HQ (-1.387, 36.756) when
 * no entries are loaded yet so the view doesn't briefly flash to lat/lng
 * (0, 0) in the Atlantic Ocean.
 */
export interface MapBaseProps {
  className?: string;
  initialCenter?: [number, number];
  initialZoom?: number;
  onReady: (map: L.Map) => void;
}

export const DEFAULT_CENTER: [number, number] = [-1.387, 36.756];
export const DEFAULT_ZOOM = 12;

export function MapBase({
  className,
  initialCenter = DEFAULT_CENTER,
  initialZoom = DEFAULT_ZOOM,
  onReady,
}: MapBaseProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = L.map(el, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
      attributionControl: false,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(map);
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
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

  // Leaflet doesn't auto-resize when the container's pixel size changes
  // (e.g. when the sidebar collapses) — invalidateSize forces a redraw.
  useEffect(() => {
    if (!ready) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      mapRef.current?.invalidateSize();
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
