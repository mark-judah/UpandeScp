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

const LIGHT_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
// "Grey" basemap = the same OSM tiles desaturated + slightly dimmed via a CSS
// filter (see .scp-grey-tiles). A true dark basemap read as near-black; a
// neutral grey keeps the coloured zone/trail overlays legible without glare.

const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

/** Inject the modern control styling once — Leaflet renders its controls as
 *  raw DOM, so Tailwind classes can't reach them. */
const MAP_STYLE_ID = "scp-map-controls-style";
function ensureControlStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(MAP_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = MAP_STYLE_ID;
  el.textContent = `
    .leaflet-bar { border: none !important; border-radius: 10px; overflow: hidden;
      box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    .leaflet-bar a, .scp-basemap-toggle {
      width: 34px; height: 34px; background: #fff; color: #374151; border: none;
      border-bottom: 1px solid rgba(0,0,0,.06);
      display: flex; align-items: center; justify-content: center; cursor: pointer;
      font-size: 18px; transition: background .12s ease, color .12s ease; }
    .leaflet-bar a:last-child, .scp-basemap-toggle { border-bottom: none; }
    .leaflet-bar a:hover, .scp-basemap-toggle:hover { background: #f3f4f6; color: #111827; }
    .scp-basemap-toggle { margin-top: 8px; border-radius: 10px;
      box-shadow: 0 2px 8px rgba(0,0,0,.18); padding: 0; }
    .scp-basemap-toggle svg { width: 16px; height: 16px; }
    .scp-grey-tiles { filter: grayscale(1) brightness(0.9) contrast(0.95); }
  `;
  document.head.appendChild(el);
}

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
    ensureControlStyles();
    const map = L.map(el, {
      center: initialCenter,
      zoom: initialZoom,
      zoomControl: true,
      attributionControl: false,
    });

    // Light (OSM) and grey (desaturated OSM) basemaps; a toggle control under
    // the zoom buttons swaps between them — affects only the map tiles.
    const light = L.tileLayer(LIGHT_TILES, {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    });
    const grey = L.tileLayer(LIGHT_TILES, {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
      className: "scp-grey-tiles",
    });
    light.addTo(map);
    let isDark = false;

    const BasemapToggle = L.Control.extend({
      options: { position: "topleft" as L.ControlPosition },
      onAdd() {
        const btn = L.DomUtil.create("button", "scp-basemap-toggle");
        btn.type = "button";
        btn.title = "Toggle light / dark map";
        btn.setAttribute("aria-label", "Toggle light or dark map");
        btn.innerHTML = MOON_SVG;
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, "click", (e) => {
          L.DomEvent.preventDefault(e);
          isDark = !isDark;
          if (isDark) {
            map.removeLayer(light);
            grey.addTo(map);
            btn.innerHTML = SUN_SVG;
          } else {
            map.removeLayer(grey);
            light.addTo(map);
            btn.innerHTML = MOON_SVG;
          }
        });
        return btn;
      },
    });
    map.addControl(new BasemapToggle());

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
