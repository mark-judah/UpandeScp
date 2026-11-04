/**
 * Opening a tree hot spot on the avocado Observations map: the alert card (or
 * a modal) leaves the block and observation in session storage and moves to the
 * map, which reads it once on mount, picks the observation, and flies to the
 * block, where the patches of that observation are outlined.
 */
import { cropSlug } from "./router";

const KEY = "scp.hotspot.focus";

export interface HotSpotFocus {
  block: string;
  kind: "pest" | "disease";
  observation: string;
}

export function openHotSpotOnMap(crop: string, focus: HotSpotFocus): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(focus));
  } catch {
    /* storage can be blocked: the map then opens unfocused */
  }
  window.location.hash = `#/${cropSlug(crop)}/observations`;
}

/** The pending focus, once: reading it clears it. */
export function takeHotSpotFocus(): HotSpotFocus | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const f = JSON.parse(raw) as HotSpotFocus;
    return f && f.block && f.observation ? f : null;
  } catch {
    return null;
  }
}
