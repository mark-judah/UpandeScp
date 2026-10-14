/** How a finding's place reads: "Chepsito GH 11 · Bed 29 · Zone 7". */
import { shortHouse } from "@/lib/places";

export interface PlaceFields {
  farm?: string;
  greenhouse?: string;
  house?: string;
  block?: string;
  bed?: string;
  zone?: string;
  tree?: string;
}

const last = (s: string, re: RegExp) => s.match(re)?.[1] ?? "";

/** The zone's own number: "Chepsito GH 11 - KR - Bed 29 - Zone 7" → "7". */
export function zoneNumber(zone: string | undefined): string {
  const z = (zone || "").trim();
  return last(z, /Zone\s+(\S+)\s*$/i) || (/ - /.test(z) ? "" : z);
}

export function bedNumber(p: PlaceFields): string {
  return (p.bed || "").trim() || last(p.zone || "", /Bed\s+(\S+?)(?:\s+-\s+|\s*$)/i);
}

/** "Chepsito GH 11" — house without the company suffix, else the farm. */
export function placeHouse(p: PlaceFields): string {
  return shortHouse(p.greenhouse || p.house || "") || p.farm || "";
}

export function formatFindingPlace(p: PlaceFields): string {
  const bed = bedNumber(p);
  const zone = zoneNumber(p.zone);
  return [
    placeHouse(p),
    p.block && `Block ${p.block}`,
    bed && `Bed ${bed}`,
    zone && `Zone ${zone}`,
    p.tree && `Tree ${p.tree}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
