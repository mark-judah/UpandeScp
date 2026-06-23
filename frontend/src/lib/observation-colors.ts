/**
 * Single source of truth for pest / disease colours across the SPA.
 *
 * Resolution order (highest precedence first):
 *   1. Live override map fetched from the Pest / Plant Disease doctypes
 *      (their ``pests_legend_color`` / ``disease_legend_color`` fields).
 *      Edit a doc → cache invalidates server-side → next call re-fetches.
 *   2. Canonical hardcoded fallback (kept in sync with the backend
 *      ``observation_colors.PEST_DEFAULTS`` / ``DISEASE_DEFAULTS``) so a
 *      fresh install — or a name we haven't seen before but matches a
 *      synonym — still renders something meaningful.
 *   3. Neutral grey when nothing matches.
 *
 * Use the React hook ``useObservationColors`` from a component to get a
 * resolver bound to the live override map; non-React callers can call
 * ``pestColor(name)`` / ``diseaseColor(name)`` directly and they'll use
 * whatever the most recent fetch loaded into the module-level cache.
 */

import { useEffect, useState } from "react";
import { call } from "./frappe";

export type ObsKind = "pest" | "disease";

export interface ObsColorMap {
  pests: Record<string, string>;
  diseases: Record<string, string>;
}

const norm = (s: string): string =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

/** ──────────────────────────────────────────────────────────────────────
 *  Canonical hardcoded fallback (mirror of observation_colors.py).
 *  ────────────────────────────────────────────────────────────────────── */

export const PEST_PALETTE: Record<string, string> = {
  FCM: "#dc2626",
  Helicoverpa: "#eab308",
  Spodoptera: "#f97316",
  Duponchelia: "#38bdf8",
  Thrips: "#2563eb",
  Spidermites: "#8b4513",
  Aphids: "#16a34a",
  "White Flies": "#6b7280",
  Mealybugs: "#d4a017",
};

export const DISEASE_PALETTE: Record<string, string> = {
  "Powdery Mildew": "#166534",
  "Downy Mildew": "#ec4899",
  Botrytis: "#a855f7",
  Agrobacteria: "#eab308",
  Rust: "#c8a165",
};

export const OBS_DEFAULT_COLOR = "#9ca3af";

const PEST_LOOKUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  const add = (keys: string[], hex: string) =>
    keys.forEach((k) => {
      m[norm(k)] = hex;
    });
  add(["FCM", "False Codling Moth", "False Codling Moths"], "#dc2626");
  add(["Helicoverpa", "Helicoverpa Armigera"], "#eab308");
  add(["Spodoptera", "Spodoptera Litura", "Spodoptera Frugiperda"], "#f97316");
  add(
    ["Duponchelia", "Duponchella", "Duponchelia Fovealis"],
    "#38bdf8",
  );
  add(["Thrips"], "#2563eb");
  add(
    ["Spidermites", "Spidermite", "Spider Mite", "Spider Mites", "Red Spider Mite"],
    "#8b4513",
  );
  add(["Aphids", "Aphid"], "#16a34a");
  add(["White Flies", "White Fly", "Whitefly", "Whiteflies"], "#6b7280");
  add(["Mealybugs", "Mealybug", "Mealy Bug", "Mealy Bugs"], "#d4a017");
  add(["Unidentified Moth", "Unknown Moth"], "#fb923c");
  return m;
})();

const DISEASE_LOOKUP: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  const add = (keys: string[], hex: string) =>
    keys.forEach((k) => {
      m[norm(k)] = hex;
    });
  add(["Powdery Mildew"], "#166534");
  add(["Downy Mildew"], "#ec4899");
  add(["Botrytis", "Botyrtis"], "#a855f7");
  add(["Agrobacteria", "Agrobacterium"], "#eab308");
  add(["Rust"], "#c8a165");
  return m;
})();

/** ──────────────────────────────────────────────────────────────────────
 *  Live doctype-fed override map. Module-level cache so every call reuses
 *  one in-flight fetch.
 *  ────────────────────────────────────────────────────────────────────── */

let liveColors: ObsColorMap = { pests: {}, diseases: {} };
let liveColorsPromise: Promise<ObsColorMap> | null = null;
type Subscriber = (map: ObsColorMap) => void;
const subscribers = new Set<Subscriber>();

function emitLive() {
  subscribers.forEach((fn) => {
    try {
      fn(liveColors);
    } catch {
      /* never let a subscriber break the others */
    }
  });
}

/** Fire-and-forget fetch of the doctype-stored colours. Cached: a second
 *  caller during the in-flight request piggybacks on the same promise. */
export function loadObservationColors(force = false): Promise<ObsColorMap> {
  if (!force && liveColorsPromise) return liveColorsPromise;
  liveColorsPromise = call<ObsColorMap>(
    "upande_scp.serverscripts.observation_colors.get_observation_colors",
    {},
  )
    .then((r) => {
      liveColors = {
        pests: (r && r.pests) || {},
        diseases: (r && r.diseases) || {},
      };
      emitLive();
      return liveColors;
    })
    .catch(() => liveColors);
  return liveColorsPromise;
}

/** Subscribe to live-map updates. Returns an unsubscribe fn. */
export function subscribeObservationColors(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Snapshot of the most recent live map (or empty if not yet loaded). */
export function getObservationColors(): ObsColorMap {
  return liveColors;
}

/** ──────────────────────────────────────────────────────────────────────
 *  Resolvers.
 *  ────────────────────────────────────────────────────────────────────── */

export function pestColor(
  name: string,
  override?: Record<string, string>,
): string {
  if (!name) return OBS_DEFAULT_COLOR;
  const live = override ?? liveColors.pests;
  if (live?.[name]) return live[name];
  // Some upstream callers normalise to lowercase before persisting; also try
  // a case-insensitive match against the live map.
  const k = norm(name);
  if (live) {
    for (const [doc, hex] of Object.entries(live)) {
      if (norm(doc) === k) return hex;
    }
  }
  const hit = PEST_LOOKUP[k];
  return hit || OBS_DEFAULT_COLOR;
}

export function diseaseColor(
  name: string,
  override?: Record<string, string>,
): string {
  if (!name) return OBS_DEFAULT_COLOR;
  const live = override ?? liveColors.diseases;
  if (live?.[name]) return live[name];
  const k = norm(name);
  if (live) {
    for (const [doc, hex] of Object.entries(live)) {
      if (norm(doc) === k) return hex;
    }
  }
  const hit = DISEASE_LOOKUP[k];
  return hit || OBS_DEFAULT_COLOR;
}

export function observationColor(
  name: string,
  kind: ObsKind,
  overrides?: Partial<ObsColorMap>,
): string {
  return kind === "pest"
    ? pestColor(name, overrides?.pests)
    : diseaseColor(name, overrides?.diseases);
}

/** Pick a readable text colour (white or charcoal) for a given hex fill. */
export function readableInk(hexBackground: string): string {
  const m = /^#?([a-f0-9]{6})$/i.exec(hexBackground.replace("#", ""));
  if (!m) return "#1f2937";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.62 ? "#1f2937" : "#ffffff";
}

/** ──────────────────────────────────────────────────────────────────────
 *  React integration.
 *  ────────────────────────────────────────────────────────────────────── */

/** Returns the live doctype colour map plus a re-render guarantee — the
 *  hook subscribes to updates so a slow first fetch refreshes consumers. */
export function useObservationColors(): {
  map: ObsColorMap;
  pest: (name: string) => string;
  disease: (name: string) => string;
} {
  const [map, setMap] = useState<ObsColorMap>(liveColors);
  useEffect(() => {
    void loadObservationColors();
    return subscribeObservationColors(setMap);
  }, []);
  return {
    map,
    pest: (name: string) => pestColor(name, map.pests),
    disease: (name: string) => diseaseColor(name, map.diseases),
  };
}

/** Static legend entries — used by the colour-key panels. */
export const PEST_LEGEND: Array<{ name: string; color: string }> = Object.entries(
  PEST_PALETTE,
).map(([name, color]) => ({ name, color }));

export const DISEASE_LEGEND: Array<{ name: string; color: string }> =
  Object.entries(DISEASE_PALETTE).map(([name, color]) => ({ name, color }));
