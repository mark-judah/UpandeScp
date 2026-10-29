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

/** A plain paper background with no network dependencies: what the map falls back to when the
 *  basemap style cannot be fetched (offline, blocked, DNS), so block boundaries, rows and hexagons
 *  still draw instead of leaving a blank canvas. Glyphs stay on OpenFreeMap: labels simply do not
 *  render if that is unreachable too. */
export const FALLBACK_STYLE = {
  version: 8 as const,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {},
  layers: [{ id: "scp-paper", type: "background" as const, paint: { "background-color": "#ece9de" } }],
};
const STYLE_TIMEOUT_MS = 10_000;

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
      attributionControl: false,
    });
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");
    // The basemap credit, folded into a small ⓘ (see MapBase's MapCredit).
    map.addControl(
      {
        onAdd() {
          const el = document.createElement("div");
          el.className = "maplibregl-ctrl scp-map-credit";
          el.innerHTML =
            '<button type="button" aria-label="Map data credits" title="Map data © OpenStreetMap contributors">i</button>' +
            '<span>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</span>';
          el.querySelector("button")!.addEventListener("click", () => el.classList.toggle("open"));
          return el;
        },
        onRemove() {},
      },
      "bottom-left",
    );
    // The map's own `load` only fires once the style arrived. If the style host is unreachable it
    // never does, and every consumer that waits for `load` before adding its layers shows nothing
    // at all: swap in the offline style so the farm still draws.
    let loaded = false;
    let fellBack = false;
    const fallBack = () => {
      if (loaded || fellBack) return;
      fellBack = true;
      map.setStyle(FALLBACK_STYLE as never);
    };
    map.once("load", () => {
      loaded = true;
    });
    map.on("error", (e) => {
      // Only the style document itself failing means "no basemap"; a missing glyph range or tile
      // is not a reason to throw the basemap away.
      const url = (e as unknown as { error?: { url?: string } }).error?.url;
      if (!loaded && url === styleUrl) fallBack();
    });
    const styleTimer = window.setTimeout(fallBack, STYLE_TIMEOUT_MS);
    mapRef.current = map;
    setReady(true);
    onReady(map);
    return () => {
      window.clearTimeout(styleTimer);
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
