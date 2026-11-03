/**
 * The "Stations" layer on a Leaflet map (rose scouting): one small solid dot per
 * recorded station in the scout's colour (no ring), drawn on its own pane above the
 * zone fills and routes, with a visit number beside it when zoomed in. Dots are
 * circle markers, so they keep a pixel size at every zoom; the open one is larger.
 */
import L from "leaflet";
import type { StationView } from "@/lib/scouting-stations";

const PANE = "scp-stations";
const NUMBER_ZOOM = 17;
const MAX_NUMBERS = 700;

/** Dot radius by zoom: ~2 px zoomed out to ~5 px close in. */
export const dotRadius = (z: number) => Math.max(2, Math.min(5, 2 + (z - 12) * 0.45));

export interface StationLayerHandle {
  update: (view: StationView, colorOf: (scout: string) => string) => void;
  setOpen: (id: string | null) => void;
  setVisible: (on: boolean) => void;
  destroy: () => void;
}

export function createStationLayer(
  map: L.Map,
  onOpen: (id: string) => void,
): StationLayerHandle {
  if (!map.getPane(PANE)) {
    const pane = map.createPane(PANE);
    pane.style.zIndex = "640";
  }
  const renderer = L.canvas({ pane: PANE, padding: 0.3 });
  const group = L.layerGroup().addTo(map);
  const numbers = L.layerGroup().addTo(map);
  let view: StationView = { stations: [], numbered: false };
  let colorOf: (s: string) => string = () => "#2BA6E0";
  let visible = true;
  let openId: string | null = null;
  let dots: Array<{ id: string; dot: L.CircleMarker; hit: L.CircleMarker }> = [];
  let open: L.CircleMarker | null = null;

  const radiusNow = () => dotRadius(map.getZoom());
  const restyle = () => {
    const r = radiusNow();
    for (const x of dots) {
      x.dot.setRadius(r);
      x.hit.setRadius(Math.max(7, r + 2));
    }
    open?.setRadius(r + 2.5);
  };
  const drawNumbers = () => {
    numbers.clearLayers();
    if (!visible || !view.numbered || map.getZoom() < NUMBER_ZOOM) return;
    const b = map.getBounds();
    let n = 0;
    for (const s of view.stations) {
      if (n >= MAX_NUMBERS) break;
      if (!b.contains([s.lat, s.lng])) continue;
      n += 1;
      L.marker([s.lat, s.lng], {
        pane: PANE,
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "",
          iconSize: [0, 0],
          html: `<div style="transform:translate(6px,-14px);font:700 11px var(--sd-font),Poppins,Arial,sans-serif;color:#0a0a0a;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff;white-space:nowrap">${s.order}</div>`,
        }),
      }).addTo(numbers);
    }
  };
  const syncOpen = () => {
    open?.remove();
    open = null;
    const s = openId ? view.stations.find((x) => x.id === openId) : undefined;
    if (!s || !visible) return;
    open = L.circleMarker([s.lat, s.lng], {
      pane: PANE,
      renderer,
      radius: radiusNow() + 2.5,
      color: "#0a0a0a",
      weight: 2,
      fillColor: colorOf(s.scout),
      fillOpacity: 1,
      interactive: false,
    }).addTo(group);
  };

  map.on("zoomend", restyle);
  map.on("zoomend moveend", drawNumbers);

  return {
    update(v, c) {
      view = v;
      colorOf = c;
      group.clearLayers();
      dots = [];
      const r = radiusNow();
      for (const s of v.stations) {
        const color = colorOf(s.scout);
        // Invisible, larger click target under the dot so a 2 px dot stays easy to hit.
        const hit = L.circleMarker([s.lat, s.lng], {
          pane: PANE,
          renderer,
          radius: Math.max(7, r + 2),
          stroke: false,
          fill: true,
          fillOpacity: 0,
          bubblingMouseEvents: false,
        });
        hit.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          onOpen(s.id);
        });
        hit.bindTooltip(`${v.numbered ? `#${s.order} · ` : ""}${s.key}`, { direction: "top" });
        const dot = L.circleMarker([s.lat, s.lng], {
          pane: PANE,
          renderer,
          radius: r,
          color: "#ffffff",
          weight: 0.75,
          fillColor: color,
          fillOpacity: 1,
          interactive: false,
        });
        hit.addTo(group);
        dot.addTo(group);
        dots.push({ id: s.id, dot, hit });
      }
      syncOpen();
      drawNumbers();
    },
    setOpen(id) {
      openId = id;
      syncOpen();
    },
    setVisible(on) {
      visible = on;
      if (on) {
        map.addLayer(group);
        map.addLayer(numbers);
        drawNumbers();
        syncOpen();
      } else {
        map.removeLayer(group);
        map.removeLayer(numbers);
      }
    },
    destroy() {
      map.off("zoomend", restyle);
      map.off("zoomend moveend", drawNumbers);
      group.remove();
      numbers.remove();
    },
  };
}
