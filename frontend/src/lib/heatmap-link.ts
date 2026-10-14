/**
 * Deep link into the Heatmaps page:
 *   #/<crop>/heatmaps?gh=<warehouse>&obs=<pest or disease>&kind=<pest|disease>
 * Pure helpers; the page applies the result once on first load and never
 * writes it to the remembered place.
 */

export interface HeatmapLink {
  gh: string;
  obs: string;
  kind: "pest" | "disease" | "";
}

export function parseHeatmapLink(hash: string): HeatmapLink {
  const q = (hash || "").split("?")[1] ?? "";
  const p = new URLSearchParams(q);
  const kind = (p.get("kind") || "").toLowerCase();
  return {
    gh: (p.get("gh") || "").trim(),
    obs: (p.get("obs") || "").trim(),
    kind: kind === "pest" || kind === "disease" ? kind : "",
  };
}

/** The station id for the house picker, or null when the house is unknown. */
export function linkStationId(link: HeatmapLink, farmsByGh: Record<string, string>): string | null {
  const farm = link.gh ? farmsByGh[link.gh] : undefined;
  return farm ? `station:${farm}|${link.gh}` : null;
}

/** The obs chip id for the target, or null when no loaded card matches it. */
export function linkObsId(
  link: HeatmapLink,
  cards: { obsName: string; obsKind: string }[],
): string | null {
  if (!link.obs) return null;
  const hit = cards.find(
    (c) => c.obsName === link.obs && (!link.kind || c.obsKind === link.kind),
  );
  return hit ? `obs:${hit.obsKind}:${hit.obsName}` : null;
}
