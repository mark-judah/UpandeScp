/**
 * mona area rule: a full greenhouse counts as exactly 1 hectare. A partial
 * scope (specific varieties or beds) is the share of the greenhouse's active
 * beds it covers, times 1 ha. Every mona bed has equal area, so bed-count
 * share equals area share. Water volume is derived elsewhere as ha * 1000.
 */
export type AreaScope =
  | "Full Greenhouse"
  | "Specific Variety"
  | "Specific Bed(s)"
  | string;

export interface AreaBed {
  bed?: string | number | null;
  variety?: string | null;
}

export function computeAreaHa(
  scope: AreaScope,
  beds: AreaBed[],
  selectedVarieties: ReadonlySet<string>,
  selectedBeds: ReadonlySet<string>,
): number {
  const total = beds.length;
  if (!total) return 0;

  if (scope === "Full Greenhouse") return 1;

  if (scope === "Specific Variety") {
    const n = beds.filter(
      (b) => b.variety != null && selectedVarieties.has(b.variety),
    ).length;
    return n / total;
  }

  if (scope === "Specific Bed(s)") {
    const n = beds.filter(
      (b) => b.bed != null && selectedBeds.has(String(b.bed)),
    ).length;
    return n / total;
  }

  return 0;
}
