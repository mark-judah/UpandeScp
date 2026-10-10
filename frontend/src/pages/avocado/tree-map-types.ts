import type { ReactNode } from "react";
import type { ProcessedData } from "@/lib/scouting-types";

/** A point overlay (e.g. a trap catch) drawn over the trees. */
export interface MarkerPoint {
  lng: number;
  lat: number;
  count: number; // drives the sqrt-scaled radius
  color: string;
  label?: string;
}

/** What a view (Scouting / Observations / Traps / …) supplies to the shell. */
export interface AvocadoView {
  title: string;
  subtitle: string;
  /** Per-tree tint from the cached entries. Empty → all trees unscouted. */
  deriveColors: (data: ProcessedData | null) => Map<string, string>;
  /** Optional point overlay (traps). Omit for tree-only views. */
  deriveMarkers?: (data: ProcessedData | null) => MarkerPoint[];
  /** Docked side-panel content. */
  renderPanel: (data: ProcessedData | null) => ReactNode;
  /** Optional controls for MapHeader's rightSlot (e.g. a pest/disease toggle). */
  headerControls?: ReactNode;
  /** Draw the per-scout movement trails layer (scouting only). */
  showTracks?: boolean;
  /** The observation whose patches the map outlines on a picked block
   *  (spread spec C5); null/absent = no patches. */
  patchObservation?: { kind: "pest" | "disease"; name: string } | null;
}
