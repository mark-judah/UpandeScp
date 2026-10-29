import type { ReactNode } from "react";
import type { ProcessedData } from "@/lib/scouting-types";
import type { TrapLocations } from "@/lib/scouting-api";

/** A point overlay (e.g. a trap catch) drawn over the trees. */
export interface MarkerPoint {
  lng: number;
  lat: number;
  count: number; // total catches: drives size and pulse
  /** Highest single catch: drives the polygon's number of sides. */
  maxCount?: number;
  /** The pest caught most here (its colour is `color`). */
  pest?: string;
  color: string; // the pest's colour (grey at zero)
  label?: string;
  /** The newest reading in the window (traps), for the click card. */
  latest?: { date: string; time: string; scout: string; count: number; pest: string };
}

/** What a view (Scouting / Observations / Traps / …) supplies to the shell. */
export interface AvocadoView {
  title: string;
  subtitle: string;
  /** Per-tree tint from the cached entries. Empty → all trees unscouted. */
  deriveColors: (data: ProcessedData | null) => Map<string, string>;
  /** Optional point overlay (traps). Omit for tree-only views. */
  deriveMarkers?: (data: ProcessedData | null) => MarkerPoint[];
  /** Title of the floating control panel that holds `renderPanel`. */
  panelTitle: string;
  /** Floating control-panel content (top-left of the map). `loading` = first load (no data yet): keep the
   *  panel's headings, put skeleton rows where the list goes. */
  renderPanel: (data: ProcessedData | null, loading?: boolean) => ReactNode;
  /** Optional controls for MapHeader's rightSlot (e.g. a pest/disease toggle). */
  headerControls?: ReactNode;
  /** Card shown over the map after a marker click has flown to it (traps). */
  markerCard?: (
    marker: MarkerPoint,
    range: { from: string; to: string },
    onClose: () => void,
  ) => ReactNode;
  /** Floating legend at the bottom-right; hidden while a marker card is open. */
  renderLegend?: (data: ProcessedData | null, loading?: boolean) => ReactNode;
  /** Colour from the one-request per-unit summary where the farm allows it (hexagons / visit
   *  points); farms with orchard trees keep the raw per-week entries. */
  aggregate?: boolean;
  /** Draw the per-scout movement trails layer (scouting only). */
  showTracks?: boolean;
  /** The observation whose patches the map outlines on a picked block
   *  (spread spec C5); null/absent = no patches. */
  patchObservation?: { kind: "pest" | "disease"; name: string } | null;
  /** Draw the map flat (2D: no tilt, pitch locked at 0) — the open-field Observations map. */
  flat?: boolean;
  /** Traps with their units (get_trap_locations): each unit is outlined and labelled with the
   *  trap number under its marker. */
  trapUnits?: TrapLocations;
}
