import { useEffect, useState } from "react";
import { call } from "@/lib/frappe";

/**
 * What kind of crop each scouted crop is, read from where it is planted (server:
 * common/crop_profile.py). The desk never decides by crop NAME whether a crop is
 * grown on blocks or in greenhouses — Potato, Onion, Cabbage and Passion Fruit on
 * pivots behave like avocado because their stations are Blocks, not because they
 * are listed anywhere.
 *
 * The last profiles are kept in localStorage, so a return visit paints the right
 * sidebar and pages on the first frame; the fetch then refreshes them.
 */
export interface CropProfile {
  crop: string;
  label: string;
  slug: string;
  /** Most common warehouse type of the crop's stations ("Greenhouse", "Block"). */
  station_type: string;
  /** Stations are not greenhouses: the block-grown pages apply. */
  block_grown: boolean;
  /** Group levels above the stations, top first: ["Phase", "Section"] or ["Pivot"]. */
  level_labels: string[];
}

const STORE_KEY = "scp.cropProfiles.v1";
const METHOD = "upande_scp.serverscripts.common.crop_profile.get_crop_profiles";

function readCache(): Record<string, CropProfile> | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CropProfile>) : null;
  } catch {
    return null;
  }
}

let profiles: Record<string, CropProfile> | null = null;
let started = false;
const listeners = new Set<() => void>();

function init() {
  if (started) return;
  started = true;
  profiles = readCache();
  call<CropProfile[]>(METHOD, {})
    .then((rows) => {
      if (!Array.isArray(rows)) return;
      profiles = Object.fromEntries(rows.map((r) => [r.slug, r]));
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(profiles));
      } catch {
        /* storage blocked: the in-memory copy still serves this session */
      }
    })
    .catch(() => {
      profiles = profiles ?? {};
    })
    .finally(() => listeners.forEach((l) => l()));
}

/** Test hook: seed or clear the store without a network call. */
export function __setCropProfiles(rows: CropProfile[] | null) {
  started = true;
  profiles = rows ? Object.fromEntries(rows.map((r) => [r.slug, r])) : null;
  listeners.forEach((l) => l());
}

export function cropProfile(slug: string): CropProfile | null {
  return profiles?.[slug] ?? null;
}

/** Is this crop grown on blocks? False until the profiles are known, and for a crop
 *  with no stations yet — the greenhouse pages are the default. */
export function isBlockGrown(slug: string): boolean {
  return cropProfile(slug)?.block_grown ?? false;
}

/** True once the profiles have loaded (or were restored from the last visit). */
export function cropProfilesReady(): boolean {
  return profiles !== null;
}

/** Subscribe a component to the profile store; kicks off the one-time fetch. */
export function useCropProfiles(): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    init();
    return () => {
      listeners.delete(l);
    };
  }, []);
  init();
  return profiles !== null;
}
