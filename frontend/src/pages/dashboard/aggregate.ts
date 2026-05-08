import type { ProcessedData } from "@/lib/scouting-types";

export interface KpiSummary {
  totalScouts: number;
  scoutNames: string[];
  zonesScouted: number;
  greenhouseCount: number;
  highAlerts: number;
}

export function computeOverviewKpis(data: ProcessedData | null): KpiSummary {
  if (!data)
    return {
      totalScouts: 0,
      scoutNames: [],
      zonesScouted: 0,
      greenhouseCount: 0,
      highAlerts: 0,
    };
  const scouts = Object.values(data.scouts);
  const zones = data.entries.length;
  const ghCount = Object.keys(data.greenhouses).length;
  const alerts = Object.values(data.greenhouses).reduce(
    (s, g) => s + g.alerts,
    0,
  );
  return {
    totalScouts: scouts.length,
    scoutNames: scouts.map((s) => s.name).sort(),
    zonesScouted: zones,
    greenhouseCount: ghCount,
    highAlerts: alerts,
  };
}

export function dailySeries(data: ProcessedData | null) {
  if (!data) return [];
  const entries = Object.entries(data.daily).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return entries.map(([date, d]) => ({
    date,
    pests: d.pests,
    diseases: d.diseases,
    traps: d.traps,
  }));
}

export function rangeTotals(data: ProcessedData | null) {
  if (!data)
    return [
      { name: "pests", value: 0 },
      { name: "diseases", value: 0 },
      { name: "traps", value: 0 },
    ];
  let p = 0,
    d = 0,
    t = 0;
  Object.values(data.daily).forEach((day) => {
    p += day.pests;
    d += day.diseases;
    t += day.traps;
  });
  return [
    { name: "pests", value: p },
    { name: "diseases", value: d },
    { name: "traps", value: t },
  ];
}

export function topScouts(
  data: ProcessedData | null,
  scoutLookup: Record<string, string> = {},
  n = 6,
) {
  if (!data) return [];
  return Object.values(data.scouts)
    .map((s) => ({
      ...s,
      // Resolve "200397" → "Mercy Sang" via the Employee lookup; fall back to
      // whatever label the entry-time normalizer produced (email prefix or ID).
      displayName: scoutLookup[s.name] || s.name,
    }))
    .sort((a, b) => b.entries - a.entries)
    .slice(0, n);
}

export function recentActivity(
  data: ProcessedData | null,
  scoutLookup: Record<string, string> = {},
  n = 8,
) {
  if (!data) return [];
  return data.entries.slice(0, n).map((e) => ({
    name: e.name,
    date: e.date_of_capture,
    time: e.time_of_capture,
    greenhouse: e.greenhouse || e.block || "—",
    zone: e.zone || e.tree || "",
    scout:
      scoutLookup[e.scouts_name] ||
      scoutLookup[e.modified_by] ||
      e.scouts_name ||
      "",
    kind: e.pests_scouting_entry.length
      ? "pest"
      : e.diseases_scouting_entry.length
        ? "disease"
        : e.trap_scouting_entry.length
          ? "trap"
          : "other",
  }));
}

export function activeAlerts(data: ProcessedData | null, n = 8) {
  if (!data) return [];
  const out: Array<{
    name: string;
    kind: "pest" | "disease";
    severity: "high" | "moderate";
    count: number;
    greenhouse: string;
    zone: string;
    date: string;
  }> = [];
  for (const e of data.entries) {
    const gh = e.greenhouse || e.block || "—";
    const zone = e.zone || e.tree || "";
    const date = e.date_of_capture;
    for (const p of e.pests_scouting_entry) {
      const sev =
        (p.count || 0) > 15 ? "high" : (p.count || 0) > 5 ? "moderate" : null;
      if (sev) {
        out.push({
          name: p.pest,
          kind: "pest",
          severity: sev,
          count: p.count || 0,
          greenhouse: gh,
          zone,
          date,
        });
      }
    }
    for (const d of e.diseases_scouting_entry) {
      const t = (d.severity_level || d.stage || "").toLowerCase();
      const sev: "high" | "moderate" | null = /high|severe|active/.test(t)
        ? "high"
        : /moderate|medium/.test(t)
          ? "moderate"
          : null;
      if (sev) {
        out.push({
          name: d.disease,
          kind: "disease",
          severity: sev,
          count: 1,
          greenhouse: gh,
          zone,
          date,
        });
      }
    }
  }
  return out
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
      return b.date.localeCompare(a.date);
    })
    .slice(0, n);
}

export function scoutPerformance(
  data: ProcessedData | null,
  scoutLookup: Record<string, string> = {},
) {
  if (!data) return [];
  // Per-scout breakdown: zones (entries), pest observations, disease observations
  const m = new Map<
    string,
    { name: string; zones: number; pests: number; diseases: number }
  >();
  data.entries.forEach((e) => {
    const id = e.scouts_name || e.modified_by || e.owner;
    if (!id) return;
    let row = m.get(id);
    if (!row) {
      row = {
        name: scoutLookup[id] || id,
        zones: 0,
        pests: 0,
        diseases: 0,
      };
      m.set(id, row);
    }
    row.zones++;
    row.pests += e.pests_scouting_entry.length;
    row.diseases += e.diseases_scouting_entry.length;
  });
  return Array.from(m.values())
    .sort((a, b) => b.zones - a.zones)
    .slice(0, 8);
}

export function scoutsPerDay(data: ProcessedData | null) {
  if (!data) return [];
  const map = new Map<string, Set<string>>();
  for (const e of data.entries) {
    if (!e.date_of_capture) continue;
    const key = e.scouts_name || e.modified_by || e.owner;
    if (!key) continue;
    let set = map.get(e.date_of_capture);
    if (!set) {
      set = new Set();
      map.set(e.date_of_capture, set);
    }
    set.add(key);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({ date, scouts: set.size }));
}

/**
 * Daily counts of the top N items as a series suitable for a multi-line chart.
 * Returns ``{ rows, keys }`` where ``rows`` is one row per date and each key
 * in ``keys`` is a top-item label whose value at that row is its count for
 * that date.
 *
 * Used by Pest / Disease / Trap tab trend headers so the user sees where
 * each top item is rising or falling — the structural counterpart to the
 * "All observations" Activity Timeline on Overview.
 */
function trendSeriesByCounts(
  pairs: Array<{ name: string; total: number; daily: Record<string, number> }>,
  topN: number,
): { rows: Array<Record<string, string | number>>; keys: string[] } {
  const top = [...pairs].sort((a, b) => b.total - a.total).slice(0, topN);
  if (!top.length) return { rows: [], keys: [] };
  const dates = new Set<string>();
  top.forEach((t) => Object.keys(t.daily).forEach((d) => dates.add(d)));
  const sortedDates = Array.from(dates).sort();
  const keys = top.map((t) => t.name);
  const rows = sortedDates.map((date) => {
    const row: Record<string, string | number> = { date };
    top.forEach((t) => (row[t.name] = t.daily[date] || 0));
    return row;
  });
  return { rows, keys };
}

export function pestTrendSeries(data: ProcessedData | null, topN = 5) {
  if (!data) return { rows: [], keys: [] };
  const pairs = Object.values(data.pests).map((p) => {
    const daily: Record<string, number> = {};
    let total = 0;
    p.counts.forEach((c) => {
      const v = c.count || 0;
      daily[c.date] = (daily[c.date] || 0) + v;
      total += v;
    });
    return { name: p.name, total, daily };
  });
  return trendSeriesByCounts(pairs, topN);
}

export function diseaseTrendSeries(data: ProcessedData | null, topN = 5) {
  if (!data) return { rows: [], keys: [] };
  const pairs = Object.values(data.diseases).map((d) => {
    const daily: Record<string, number> = {};
    let total = 0;
    d.counts.forEach((c) => {
      daily[c.date] = (daily[c.date] || 0) + 1;
      total += 1;
    });
    return { name: d.name, total, daily };
  });
  return trendSeriesByCounts(pairs, topN);
}

export function trapTrendSeries(data: ProcessedData | null, topN = 5) {
  if (!data) return { rows: [], keys: [] };
  // Aggregate by pest (rather than trap × pest pair) — fewer lines, clearer.
  const byPest: Record<
    string,
    { name: string; total: number; daily: Record<string, number> }
  > = {};
  Object.values(data.traps).forEach((t) => {
    const k = t.pest;
    if (!byPest[k]) byPest[k] = { name: k, total: 0, daily: {} };
    t.counts.forEach((c) => {
      const v = c.count || 0;
      byPest[k].daily[c.date] = (byPest[k].daily[c.date] || 0) + v;
      byPest[k].total += v;
    });
  });
  return trendSeriesByCounts(Object.values(byPest), topN);
}

/* ============================================================
 * Percentage-based metrics shared by the Pest / Disease tabs.
 *
 * Mirrors the Trends page calculation:
 *   numerator   = distinct zones with the matching observation
 *   denominator = total zones in the unit (Σ zonesByGreenhouse)
 *   value       = (n / d) × 100, rounded 1 dp
 *
 * Skip rule preserved: a day with no matching observation returns null
 * so charts walk over gaps instead of dropping to 0.
 * ============================================================ */

export interface DashFilters {
  /** "" means "all". Specific pest/disease to drill into. */
  observation: string;
  /** "" means "all". Plant section. */
  section: string;
  /** "" means "all". Stage. */
  stage: string;
}

export const ALL_FILTER = "";

function totalZonesInScope(
  data: ProcessedData,
  zonesByGh: Record<string, number>,
): number {
  // The scope is whatever greenhouses appeared in the filtered entries.
  let total = 0;
  Object.keys(data.greenhouses).forEach((gh) => {
    total += zonesByGh[gh] || 0;
  });
  return total;
}

function uniqueZoneKey(e: {
  zone?: string;
  bed?: string;
  block?: string;
  tree?: string;
}): string {
  if (e.block) return e.tree ? `${e.block}::tree::${e.tree}` : "";
  if (e.zone) return `zone::${e.zone}`;
  if (e.bed) return `bed::${e.bed}`;
  return "";
}

/** Pest Trends — daily % zones infected, filter-aware (pest/section/stage). */
export function pestDailyPercent(
  data: ProcessedData | null,
  zonesByGh: Record<string, number>,
  filters: DashFilters,
): { rows: Array<{ date: string; value: number | null }>; pestName: string } {
  const pestName = filters.observation || "All pests";
  if (!data) return { rows: [], pestName };
  const denom = totalZonesInScope(data, zonesByGh) || 1;
  const dayMap = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    if (!e.date_of_capture) return;
    const matched = e.pests_scouting_entry.some((p) => {
      if (filters.observation && p.pest !== filters.observation) return false;
      if (filters.section && p.plant_section !== filters.section) return false;
      if (filters.stage && (p.stage || "") !== filters.stage) return false;
      return true;
    });
    if (!matched) return;
    const u = uniqueZoneKey(e);
    if (!u) return;
    let set = dayMap.get(e.date_of_capture);
    if (!set) {
      set = new Set();
      dayMap.set(e.date_of_capture, set);
    }
    set.add(u);
  });
  const rows = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({
      date,
      value: Math.round((set.size / denom) * 1000) / 10,
    }));
  return { rows, pestName };
}

/** Disease Trends — daily % zones with disease, filter-aware. */
export function diseaseDailyPercent(
  data: ProcessedData | null,
  zonesByGh: Record<string, number>,
  filters: DashFilters,
): { rows: Array<{ date: string; value: number | null }>; diseaseName: string } {
  const diseaseName = filters.observation || "All diseases";
  if (!data) return { rows: [], diseaseName };
  const denom = totalZonesInScope(data, zonesByGh) || 1;
  const dayMap = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    if (!e.date_of_capture) return;
    const matched = e.diseases_scouting_entry.some((d) => {
      if (filters.observation && d.disease !== filters.observation) return false;
      if (filters.section && d.plant_section !== filters.section) return false;
      if (filters.stage && (d.stage || "") !== filters.stage) return false;
      return true;
    });
    if (!matched) return;
    const u = uniqueZoneKey(e);
    if (!u) return;
    let set = dayMap.get(e.date_of_capture);
    if (!set) {
      set = new Set();
      dayMap.set(e.date_of_capture, set);
    }
    set.add(u);
  });
  const rows = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, set]) => ({
      date,
      value: Math.round((set.size / denom) * 1000) / 10,
    }));
  return { rows, diseaseName };
}

/** % of total zones (in scope) that have each pest type. */
export function pestDistributionPercent(
  data: ProcessedData | null,
  zonesByGh: Record<string, number>,
  filters: DashFilters,
): Array<{ name: string; pct: number; zones: number }> {
  if (!data) return [];
  const denom = totalZonesInScope(data, zonesByGh) || 1;
  const zonesByPest = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    e.pests_scouting_entry.forEach((p) => {
      if (filters.section && p.plant_section !== filters.section) return;
      if (filters.stage && (p.stage || "") !== filters.stage) return;
      const u = uniqueZoneKey(e);
      if (!u) return;
      let set = zonesByPest.get(p.pest);
      if (!set) {
        set = new Set();
        zonesByPest.set(p.pest, set);
      }
      set.add(u);
    });
  });
  return Array.from(zonesByPest.entries())
    .map(([name, set]) => ({
      name,
      zones: set.size,
      pct: Math.round((set.size / denom) * 1000) / 10,
    }))
    .sort((a, b) => b.zones - a.zones);
}

export function diseaseDistributionPercent(
  data: ProcessedData | null,
  zonesByGh: Record<string, number>,
  filters: DashFilters,
): Array<{ name: string; pct: number; zones: number }> {
  if (!data) return [];
  const denom = totalZonesInScope(data, zonesByGh) || 1;
  const zonesByDisease = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    e.diseases_scouting_entry.forEach((d) => {
      if (filters.section && d.plant_section !== filters.section) return;
      if (filters.stage && (d.stage || "") !== filters.stage) return;
      const u = uniqueZoneKey(e);
      if (!u) return;
      let set = zonesByDisease.get(d.disease);
      if (!set) {
        set = new Set();
        zonesByDisease.set(d.disease, set);
      }
      set.add(u);
    });
  });
  return Array.from(zonesByDisease.entries())
    .map(([name, set]) => ({
      name,
      zones: set.size,
      pct: Math.round((set.size / denom) * 1000) / 10,
    }))
    .sort((a, b) => b.zones - a.zones);
}

/** Plant section split as % of total observation zones (denominator = sum
 * of zones across all sections, not total greenhouse zones, so percentages
 * tell you *where* something is concentrated rather than the absolute %). */
export function pestSectionPercent(
  data: ProcessedData | null,
  filters: DashFilters,
): Array<{ name: string; pct: number; zones: number }> {
  if (!data) return [];
  const sections = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    e.pests_scouting_entry.forEach((p) => {
      if (filters.observation && p.pest !== filters.observation) return;
      if (filters.stage && (p.stage || "") !== filters.stage) return;
      const sec = (p.plant_section || "Unknown").trim() || "Unknown";
      const u = uniqueZoneKey(e);
      if (!u) return;
      let set = sections.get(sec);
      if (!set) {
        set = new Set();
        sections.set(sec, set);
      }
      set.add(u);
    });
  });
  const total = Array.from(sections.values()).reduce(
    (s, x) => s + x.size,
    0,
  ) || 1;
  return Array.from(sections.entries())
    .map(([name, set]) => ({
      name,
      zones: set.size,
      pct: Math.round((set.size / total) * 1000) / 10,
    }))
    .sort((a, b) => b.zones - a.zones);
}

export function diseaseSectionPercent(
  data: ProcessedData | null,
  filters: DashFilters,
): Array<{ name: string; pct: number; zones: number }> {
  if (!data) return [];
  const sections = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    e.diseases_scouting_entry.forEach((d) => {
      if (filters.observation && d.disease !== filters.observation) return;
      if (filters.stage && (d.stage || "") !== filters.stage) return;
      const sec = (d.plant_section || "Unknown").trim() || "Unknown";
      const u = uniqueZoneKey(e);
      if (!u) return;
      let set = sections.get(sec);
      if (!set) {
        set = new Set();
        sections.set(sec, set);
      }
      set.add(u);
    });
  });
  const total = Array.from(sections.values()).reduce(
    (s, x) => s + x.size,
    0,
  ) || 1;
  return Array.from(sections.entries())
    .map(([name, set]) => ({
      name,
      zones: set.size,
      pct: Math.round((set.size / total) * 1000) / 10,
    }))
    .sort((a, b) => b.zones - a.zones);
}

/** % zones with the matched observation per greenhouse. */
export function greenhousePressurePercent(
  data: ProcessedData | null,
  zonesByGh: Record<string, number>,
  kind: "pest" | "disease",
  filters: DashFilters,
): Array<{ name: string; pct: number; zones: number }> {
  if (!data) return [];
  const ghToZones = new Map<string, Set<string>>();
  data.entries.forEach((e) => {
    const gh = e.greenhouse || e.block;
    if (!gh) return;
    const list =
      kind === "pest" ? e.pests_scouting_entry : e.diseases_scouting_entry;
    const matched = list.some((row: any) => {
      if (kind === "pest") {
        if (filters.observation && row.pest !== filters.observation) return false;
      } else {
        if (filters.observation && row.disease !== filters.observation) return false;
      }
      if (filters.section && row.plant_section !== filters.section) return false;
      if (filters.stage && (row.stage || "") !== filters.stage) return false;
      return true;
    });
    if (!matched) return;
    const u = uniqueZoneKey(e);
    if (!u) return;
    let set = ghToZones.get(gh);
    if (!set) {
      set = new Set();
      ghToZones.set(gh, set);
    }
    set.add(u);
  });
  return Array.from(ghToZones.entries())
    .map(([name, set]) => ({
      name,
      zones: set.size,
      pct: Math.round(((set.size / Math.max(1, zonesByGh[name] || 0)) * 1000)) /
        10,
    }))
    .sort((a, b) => b.pct - a.pct);
}

/** Distinct option lists for the filter selectors. */
export function pestFilterOptions(data: ProcessedData | null) {
  const pests = new Set<string>();
  const sections = new Set<string>();
  const stages = new Set<string>();
  if (!data) return { pests: [], sections: [], stages: [] };
  data.entries.forEach((e) =>
    e.pests_scouting_entry.forEach((p) => {
      if (p.pest) pests.add(p.pest);
      if (p.plant_section) sections.add(p.plant_section);
      if (p.stage) stages.add(p.stage);
    }),
  );
  return {
    pests: Array.from(pests).sort(),
    sections: Array.from(sections).sort(),
    stages: Array.from(stages).sort(),
  };
}

export function diseaseFilterOptions(data: ProcessedData | null) {
  const diseases = new Set<string>();
  const sections = new Set<string>();
  const stages = new Set<string>();
  if (!data) return { diseases: [], sections: [], stages: [] };
  data.entries.forEach((e) =>
    e.diseases_scouting_entry.forEach((d) => {
      if (d.disease) diseases.add(d.disease);
      if (d.plant_section) sections.add(d.plant_section);
      if (d.stage) stages.add(d.stage);
    }),
  );
  return {
    diseases: Array.from(diseases).sort(),
    sections: Array.from(sections).sort(),
    stages: Array.from(stages).sort(),
  };
}

export function pestRanking(data: ProcessedData | null) {
  if (!data) return [];
  return Object.values(data.pests)
    .map((p) => ({
      name: p.name,
      total: p.counts.reduce((s, c) => s + (c.count || 0), 0),
      high: p.severity.high,
      moderate: p.severity.moderate,
      low: p.severity.low,
    }))
    .sort((a, b) => b.total - a.total);
}

export function diseaseRanking(data: ProcessedData | null) {
  if (!data) return [];
  return Object.values(data.diseases)
    .map((d) => ({
      name: d.name,
      total: d.counts.length,
      high: d.severity.high,
      moderate: d.severity.moderate,
      low: d.severity.low,
    }))
    .sort((a, b) => b.total - a.total);
}

export function trapRanking(data: ProcessedData | null) {
  if (!data) return [];
  return Object.values(data.traps)
    .map((t) => ({
      key: `${t.trap}-${t.pest}`,
      trap: t.trap,
      pest: t.pest,
      total: t.total,
      avg: t.counts.length ? Math.round(t.total / t.counts.length) : 0,
    }))
    .sort((a, b) => b.total - a.total);
}

export function trapPestBreakdown(data: ProcessedData | null) {
  if (!data) return [];
  const map: Record<string, number> = {};
  Object.values(data.traps).forEach((t) => {
    map[t.pest] = (map[t.pest] || 0) + t.total;
  });
  return Object.entries(map)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Per-greenhouse drill-down data for the Greenhouse Health modal.
 * Echoes the JS dashboard's gh-modal: top pests / diseases by count, trap
 * roll-up, and a daily trend (one line each for pests / diseases / traps).
 */
export function greenhouseDetail(
  data: ProcessedData | null,
  greenhouse: string,
): {
  topPests: Array<{ name: string; count: number }>;
  topDiseases: Array<{ name: string; count: number }>;
  traps: Array<{ pest: string; total: number }>;
  daily: Array<{ date: string; pests: number; diseases: number; traps: number }>;
  scouts: number;
  alerts: number;
} {
  const empty = {
    topPests: [],
    topDiseases: [],
    traps: [],
    daily: [],
    scouts: 0,
    alerts: 0,
  } as ReturnType<typeof greenhouseDetail>;
  if (!data || !greenhouse) return empty;

  const pestMap: Record<string, number> = {};
  const diseaseMap: Record<string, number> = {};
  const trapMap: Record<string, number> = {};
  const scouts = new Set<string>();
  const dailyMap: Record<
    string,
    { date: string; pests: number; diseases: number; traps: number }
  > = {};
  let alerts = 0;

  data.entries.forEach((e) => {
    const wh = e.greenhouse || e.block;
    if (wh !== greenhouse) return;
    const date = e.date_of_capture;
    if (date && !dailyMap[date])
      dailyMap[date] = { date, pests: 0, diseases: 0, traps: 0 };
    if (e.scouts_name) scouts.add(e.scouts_name);
    e.pests_scouting_entry.forEach((p) => {
      pestMap[p.pest] = (pestMap[p.pest] || 0) + (p.count || 1);
      if (date) dailyMap[date].pests += 1;
      if ((p.count || 0) > 15) alerts++;
    });
    e.diseases_scouting_entry.forEach((d) => {
      diseaseMap[d.disease] = (diseaseMap[d.disease] || 0) + 1;
      if (date) dailyMap[date].diseases += 1;
    });
    e.trap_scouting_entry.forEach((t) => {
      trapMap[t.pest || "Unknown"] =
        (trapMap[t.pest || "Unknown"] || 0) + (t.count || 0);
      if (date) dailyMap[date].traps += 1;
      if ((t.count || 0) > 10) alerts++;
    });
  });

  return {
    topPests: Object.entries(pestMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    topDiseases: Object.entries(diseaseMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    traps: Object.entries(trapMap)
      .map(([pest, total]) => ({ pest, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6),
    daily: Object.values(dailyMap).sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    scouts: scouts.size,
    alerts,
  };
}

export function ghHealth(data: ProcessedData | null) {
  if (!data) return [];
  return Object.values(data.greenhouses)
    .map((g) => {
      const total = g.pests + g.diseases + g.traps;
      const status: "good" | "warning" | "critical" =
        g.alerts > 2 ? "critical" : g.alerts > 0 ? "warning" : "good";
      return {
        name: g.name,
        pests: g.pests,
        diseases: g.diseases,
        traps: g.traps,
        scoutCount: g.scoutCount || 0,
        alerts: g.alerts,
        total,
        status,
      };
    })
    .sort((a, b) => b.total - a.total);
}
