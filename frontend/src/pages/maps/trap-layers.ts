/**
 * Traps on a MapLibre map, shared by the open-field maps (Traps, Application Plan): the pulsing
 * DOM markers (lib/trap-pulse: polygon + ring, size and pulse by catch, the pest's colour) and the
 * unit each trap hangs on (lib/trap-units: the hexagon / bed outlined, a ring for a tree or a bare
 * trap, the trap number as a label).
 */
import maplibregl from "maplibre-gl";
import { prefersReducedMotion, trapMarkerColors, trapMarkerHtml, trapPulse } from "@/lib/trap-pulse";
import type { TrapUnitLayers } from "@/lib/trap-units";
import type { MarkerPoint } from "../avocado/tree-map-types";

export const TRAP_UNIT_LAYERS = ["trap-unit-line", "trap-unit-ring", "trap-unit-label"] as const;

/** Add one pulsing marker per trap; `onOpen` on click / Enter. Returns label → marker. */
export function addTrapMarkers(
  map: maplibregl.Map,
  markers: MarkerPoint[],
  onOpen: (m: MarkerPoint) => void,
): Map<string, maplibregl.Marker> {
  const reduced = prefersReducedMotion();
  const out = new Map<string, maplibregl.Marker>();
  markers.forEach((m, i) => {
    const { size } = trapPulse(m.count);
    const el = document.createElement("div");
    el.className = "scp-trap-marker";
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.cursor = "pointer";
    el.title = `${m.label || ""} · ${m.count} catches`;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Trap ${m.label || ""}`.trim());
    el.dataset.trap = m.label || "";
    el.tabIndex = 0;
    el.innerHTML = trapMarkerHtml({
      key: m.label || `${m.lng},${m.lat}`,
      count: m.count,
      maxCount: m.maxCount,
      reducedMotion: reduced,
      ...trapMarkerColors(m.color, m.count),
    });
    const open = (ev: Event) => {
      ev.stopPropagation();
      onOpen(m);
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Enter" || (ev as KeyboardEvent).key === " ") open(ev);
    });
    const mk = new maplibregl.Marker({ element: el }).setLngLat([m.lng, m.lat]).addTo(map);
    out.set(m.label || `#${i}`, mk);
  });
  return out;
}

/** Fly IN to a trap (never out), then `reveal` once there (at once under reduced motion). */
export function flyToTrap(map: maplibregl.Map, m: MarkerPoint, zoomTo: number, reveal: () => void): void {
  const zoom = Math.max(map.getZoom(), zoomTo);
  if (prefersReducedMotion()) {
    map.jumpTo({ center: [m.lng, m.lat], zoom });
    reveal();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    reveal();
  };
  // Listen only after flyTo starts: stopping an earlier flight fires moveend synchronously.
  map.flyTo({ center: [m.lng, m.lat], zoom, duration: 600, essential: false });
  map.once("moveend", once);
  window.setTimeout(once, 1000);
}

function setSource(map: maplibregl.Map, id: string, data: unknown) {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data as never);
  else map.addSource(id, { type: "geojson", data: data as never });
}

/** Draw (or redraw) the traps' units and number labels, above the field and the outlines. */
export function drawTrapUnits(map: maplibregl.Map, layers: TrapUnitLayers, visible = true): void {
  setSource(map, "trap-unit-outlines", layers.outlines);
  setSource(map, "trap-unit-rings", layers.rings);
  setSource(map, "trap-unit-labels", layers.labels);
  if (!map.getLayer("trap-unit-line")) {
    map.addLayer({
      id: "trap-unit-line",
      type: "line",
      source: "trap-unit-outlines",
      paint: { "line-color": ["get", "c"] as never, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 19, 3.5] as never, "line-opacity": 0.95 },
    });
    map.addLayer({
      id: "trap-unit-ring",
      type: "circle",
      source: "trap-unit-rings",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 4, 19, 14] as never,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": ["get", "c"] as never,
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "trap-unit-label",
      type: "symbol",
      source: "trap-unit-labels",
      minzoom: 14,
      layout: {
        "text-field": ["get", "label"] as never,
        "text-size": 11,
        "text-offset": [0, 1.6],
        "text-anchor": "top",
        "text-allow-overlap": true,
        "text-font": ["Noto Sans Regular"],
      },
      paint: { "text-color": "#1f1f1c", "text-halo-color": "#ffffff", "text-halo-width": 1.5 },
    });
  }
  for (const id of TRAP_UNIT_LAYERS) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}
