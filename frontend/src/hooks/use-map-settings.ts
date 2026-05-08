/**
 * React hook + leaflet helper for the cached Map Settings payload —
 * global default lat/lon/zoom plus per-farm overrides from the
 * ``Map Settings`` / ``Farm Map Coordinate`` doctype. Used by every
 * scouting map page so picking a farm in the header re-frames the
 * map to that farm's centre + preferred zoom.
 *
 * Reads only from the IDB-cached payload (warmed on app boot via
 * ``primeMapSettings``); this hook never causes a network round-trip
 * after the first session boot.
 */

import { useEffect, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import {
  fetchMapSettings,
  type FarmCoord,
  type MapSettings,
} from "@/lib/scouting-api";

const EMPTY: MapSettings = { lat: 0, lon: 0, default_zoom: 16, farms: {} };

export function useMapSettings(): MapSettings {
  const [settings, setSettings] = useState<MapSettings>(EMPTY);
  useEffect(() => {
    let cancelled = false;
    fetchMapSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return settings;
}

/**
 * Re-frame a leaflet map to a specific farm's saved coordinates, or to
 * the global default when ``farm`` is null/empty/unknown. Animates the
 * transition so the operator sees the relocation rather than a hard
 * jump. Caller can pass ``animate: false`` for the initial boot frame.
 */
export function flyToFarm(
  map: LeafletMap | null | undefined,
  settings: MapSettings,
  farm: string | null | undefined,
  options: { animate?: boolean } = {},
): void {
  if (!map) return;
  const coord: FarmCoord | undefined =
    farm && settings.farms[farm] ? settings.farms[farm] : undefined;
  const target = coord
    ? { lat: coord.lat, lon: coord.lon, zoom: coord.zoom }
    : {
        lat: settings.lat || 0,
        lon: settings.lon || 0,
        zoom: settings.default_zoom || 16,
      };
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return;
  const animate = options.animate !== false;
  if (animate) {
    map.flyTo([target.lat, target.lon], target.zoom, {
      duration: 0.85,
      easeLinearity: 0.5,
    });
  } else {
    map.setView([target.lat, target.lon], target.zoom);
  }
}
