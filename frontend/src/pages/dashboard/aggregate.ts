// Pure transforms turning the raw scouting payload into chart-ready datasets.
// Mirrors the structures built in www/scouting_dashboard.js (buildScoutingData).

import type {
  PestColor,
  DiseaseColor,
  ScoutingEntry,
  ScoutingPayload,
} from "@/lib/scouting-api"

export interface PestSummary {
  name: string
  total: number
  stages: Record<string, number>
  sections: Record<string, number>
  severity: { low: number; moderate: number; high: number }
}

export interface DiseaseSummary {
  name: string
  total: number
  stages: Record<string, number>
  severity: { low: number; moderate: number; high: number }
}

export interface TrapSummary {
  trap: string
  pest: string
  location: string | null
  total: number
}

export interface GreenhouseSummary {
  name: string
  pests: number
  diseases: number
  traps: number
  scouts: Set<string>
  alerts: number
}

export interface DailyBucket {
  date: string
  pests: number
  diseases: number
  traps: number
  total: number
}

export interface ScoutSummary {
  key: string
  label: string
  entries: number
  pestObservations: number
  diseaseObservations: number
  trapObservations: number
}

export interface AggregatedScouting {
  totalEntries: number
  pests: PestSummary[]
  diseases: DiseaseSummary[]
  traps: TrapSummary[]
  greenhouses: GreenhouseSummary[]
  scouts: ScoutSummary[]
  daily: DailyBucket[]
  totalPestObservations: number
  totalDiseaseObservations: number
  totalTrapObservations: number
  totalAlerts: number
  pestColors: Record<string, string>
  diseaseColors: Record<string, string>
}

const titleCaseEmail = (email: string): string =>
  email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")

const scoutIdentity = (entry: ScoutingEntry): { key: string; label: string } => {
  const name = entry.scouts_name?.toString().trim() ?? ""
  if (name) return { key: name.toLowerCase(), label: name }
  const owner = entry.owner ?? entry.modified_by ?? ""
  if (owner) return { key: owner.toLowerCase(), label: titleCaseEmail(owner) }
  return { key: "", label: "" }
}

export const extractColors = (
  pestColors: PestColor[] | undefined,
  diseaseColors: DiseaseColor[] | undefined,
): { pestColors: Record<string, string>; diseaseColors: Record<string, string> } => {
  const out = { pestColors: {} as Record<string, string>, diseaseColors: {} as Record<string, string> }
  for (const p of pestColors ?? []) {
    const key = p.pest ?? p.name
    if (key && p.color) out.pestColors[key] = p.color
  }
  for (const d of diseaseColors ?? []) {
    const key = d.disease ?? d.name
    if (key && d.color) out.diseaseColors[key] = d.color
  }
  return out
}

export const aggregate = (payload: ScoutingPayload | null | undefined): AggregatedScouting => {
  const empty: AggregatedScouting = {
    totalEntries: 0,
    pests: [],
    diseases: [],
    traps: [],
    greenhouses: [],
    scouts: [],
    daily: [],
    totalPestObservations: 0,
    totalDiseaseObservations: 0,
    totalTrapObservations: 0,
    totalAlerts: 0,
    pestColors: {},
    diseaseColors: {},
  }
  if (!payload) return empty

  const colors = extractColors(payload.pest_colors, payload.disease_colors)
  const pestsMap = new Map<string, PestSummary>()
  const diseasesMap = new Map<string, DiseaseSummary>()
  const trapsMap = new Map<string, TrapSummary>()
  const greenhousesMap = new Map<string, GreenhouseSummary>()
  const scoutsMap = new Map<string, ScoutSummary>()
  const dailyMap = new Map<string, DailyBucket>()

  let totalPest = 0
  let totalDisease = 0
  let totalTrap = 0

  for (const entry of payload.entries ?? []) {
    const date = entry.date_of_capture
    const greenhouse = entry.greenhouse ?? "Unknown"
    if (!greenhousesMap.has(greenhouse)) {
      greenhousesMap.set(greenhouse, {
        name: greenhouse,
        pests: 0,
        diseases: 0,
        traps: 0,
        scouts: new Set(),
        alerts: 0,
      })
    }
    const ghEntry = greenhousesMap.get(greenhouse)!

    if (!dailyMap.has(date)) {
      dailyMap.set(date, { date, pests: 0, diseases: 0, traps: 0, total: 0 })
    }
    const day = dailyMap.get(date)!
    day.total++

    const ident = scoutIdentity(entry)
    if (ident.key) {
      ghEntry.scouts.add(ident.key)
      if (!scoutsMap.has(ident.key)) {
        scoutsMap.set(ident.key, {
          key: ident.key,
          label: ident.label || ident.key,
          entries: 0,
          pestObservations: 0,
          diseaseObservations: 0,
          trapObservations: 0,
        })
      }
      scoutsMap.get(ident.key)!.entries++
    }

    // Pests
    for (const p of entry.pests ?? []) {
      const name = p.pest || "Unknown"
      const stage = p.stage || "Unknown"
      const section = p.plant_section || ""
      const cnt = Number(p.count ?? 1) || 1
      day.pests++
      ghEntry.pests++
      totalPest++
      if (!pestsMap.has(name)) {
        pestsMap.set(name, {
          name,
          total: 0,
          stages: {},
          sections: {},
          severity: { low: 0, moderate: 0, high: 0 },
        })
      }
      const ps = pestsMap.get(name)!
      ps.total++
      ps.stages[stage] = (ps.stages[stage] || 0) + cnt
      if (section) ps.sections[section] = (ps.sections[section] || 0) + cnt
      if (cnt > 15) ps.severity.high++
      else if (cnt > 5) ps.severity.moderate++
      else ps.severity.low++
      if (ident.key) scoutsMap.get(ident.key)!.pestObservations++
    }

    // Diseases
    for (const d of entry.diseases ?? []) {
      const name = d.disease || "Unknown"
      const stage = (d.stage || "").toString()
      day.diseases++
      ghEntry.diseases++
      totalDisease++
      if (!diseasesMap.has(name)) {
        diseasesMap.set(name, {
          name,
          total: 0,
          stages: {},
          severity: { low: 0, moderate: 0, high: 0 },
        })
      }
      const ds = diseasesMap.get(name)!
      ds.total++
      if (stage) ds.stages[stage] = (ds.stages[stage] || 0) + 1
      const sev = stage.toLowerCase()
      if (/(high|severe|active)/.test(sev)) ds.severity.high++
      else if (/(moderate|medium)/.test(sev)) ds.severity.moderate++
      else ds.severity.low++
      if (ident.key) scoutsMap.get(ident.key)!.diseaseObservations++
    }

    // Traps
    for (const t of entry.traps ?? []) {
      const trap = t.trap || "Unknown"
      const pest = t.pest || "Unknown"
      const cnt = Number(t.count ?? 0) || 0
      day.traps++
      ghEntry.traps++
      totalTrap++
      const key = `${trap}-${pest}`
      if (!trapsMap.has(key)) {
        trapsMap.set(key, { trap, pest, location: t.location ?? null, total: 0 })
      }
      trapsMap.get(key)!.total += cnt
      if (cnt > 10) ghEntry.alerts++
      if (ident.key) scoutsMap.get(ident.key)!.trapObservations++
    }
  }

  return {
    totalEntries: payload.entries?.length ?? 0,
    pests: Array.from(pestsMap.values()).sort((a, b) => b.total - a.total),
    diseases: Array.from(diseasesMap.values()).sort((a, b) => b.total - a.total),
    traps: Array.from(trapsMap.values()).sort((a, b) => b.total - a.total),
    greenhouses: Array.from(greenhousesMap.values()).sort((a, b) => b.pests + b.diseases + b.traps - (a.pests + a.diseases + a.traps)),
    scouts: Array.from(scoutsMap.values()).sort((a, b) => b.entries - a.entries),
    daily: Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    totalPestObservations: totalPest,
    totalDiseaseObservations: totalDisease,
    totalTrapObservations: totalTrap,
    totalAlerts: Array.from(greenhousesMap.values()).reduce((s, g) => s + g.alerts, 0),
    pestColors: colors.pestColors,
    diseaseColors: colors.diseaseColors,
  }
}

export const farmFromGreenhouse = (greenhouse: string): string => {
  const farms = ["Chepsito", "Kaptumbo", "Kapkolia", "Torongo", "Simotwo", "Main"]
  const lower = (greenhouse || "").toLowerCase()
  return farms.find((f) => lower.includes(f.toLowerCase())) ?? ""
}
