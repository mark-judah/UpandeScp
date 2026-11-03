/**
 * The "Stations" layer on a Leaflet map (rose scouting): one ring + dot per
 * recorded station in the scout's colour, drawn on its own pane above the zone
 * fills and routes, with a visit number beside it when zoomed in. Rings are
 * circle markers, so they keep a pixel size at every zoom.
 */
import L from "leaflet";
import type { StationView } from "@/lib/scouting-stations";

const PANE = "scp-stations";
const NUMBER_ZOOM = 17;
const MAX_NUMBERS = 700;

const ringRadius = (z: number) => Math.max(4, Math.min(11, 2.5 + (z - 12) * 1.1));

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
  let rings: Array<{ id: string; ring: L.CircleMarker; dot: L.CircleMarker }> = [];
  let open: L.CircleMarker | null = null;

  const radiusNow = () => ringRadius(map.getZoom());
  const restyle = () => {
    const r = radiusNow();
    for (const x of rings) {
      x.ring.setRadius(r);
      x.dot.setRadius(Math.max(1.8, r * 0.42));
    }
    open?.setRadius(r + 4);
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
          html: `<div style="transform:translate(8px,-18px);font:700 11px var(--sd-font),Poppins,Arial,sans-serif;color:#0a0a0a;text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff;white-space:nowrap">${s.order}</div>`,
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
      radius: radiusNow() + 4,
      color: "#0a0a0a",
      weight: 2,
      fillColor: "#0a0a0a",
      fillOpacity: 0.18,
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
      rings = [];
      const r = radiusNow();
      for (const s of v.stations) {
        const color = colorOf(s.scout);
        const ring = L.circleMarker([s.lat, s.lng], {
          pane: PANE,
          renderer,
          radius: r,
          color,
          weight: 2.5,
          fillColor: "#ffffff",
          fillOpacity: 1,
          bubblingMouseEvents: false,
        });
        ring.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          onOpen(s.id);
        });
        ring.bindTooltip(`${v.numbered ? `#${s.order} · ` : ""}${s.key}`, { direction: "top" });
        const dot = L.circleMarker([s.lat, s.lng], {
          pane: PANE,
          renderer,
          radius: Math.max(1.8, r * 0.42),
          stroke: false,
          fillColor: color,
          fillOpacity: 1,
          interactive: false,
        });
        ring.addTo(group);
        dot.addTo(group);
        rings.push({ id: s.id, ring, dot });
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
