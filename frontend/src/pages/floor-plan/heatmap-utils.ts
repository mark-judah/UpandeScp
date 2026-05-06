import type {
  ScoutingEntry,
  ScoutingReport,
  SusceptibilityRow,
} from "@/lib/scp-api"

export interface ProcessedObservation {
  type: string
  name: string
  count: number
  stage: string
  symbol: string
  color: string
  plant_section: string
}

export interface ProcessedScouting {
  dataMap: Map<string, ProcessedObservation[]>
  observationsByType: Record<string, Set<string>>
  stagesInGreenhouse: Set<string>
  sectionsInGreenhouse: Set<string>
  activeObservationTypes: string[]
  varietyGroups: Map<string, Set<string>>
}

export const TYPE_MAP: Record<string, string> = {
  diseases_scouting_entry: "disease",
  pests_scouting_entry: "pest",
  weeds_scouting_entry: "weed",
  physiological_disorders_entry: "physiological_disorder",
  incidents_scouting_entry: "incident",
}

export const PLANT_SECTIONS = ["Base", "Stem", "Middle", "Top", "Buds"] as const

export const parseBedNumber = (bed: string | undefined | null): number | null => {
  if (!bed) return null
  const m = String(bed).match(/Bed (\d+)/)
  return m ? Number.parseInt(m[1], 10) : null
}

export const getZoneNumber = (zone: unknown): number | null => {
  if (typeof zone === "number") return zone
  if (typeof zone === "string") {
    const m = zone.match(/Zone (\d+)/)
    if (m) return Number.parseInt(m[1], 10)
  }
  return null
}

export const normalizeVarietyName = (name: string | null | undefined): string => {
  if (!name) return ""
  return String(name).replace(/-\s*\d+(?:\.\d+)?\s*cm$/i, "").trim()
}

export const findMaxDimensions = (entries: ScoutingEntry[]) => {
  let maxBed = 0
  let maxZone = 0
  for (const e of entries) {
    const b = parseBedNumber(e.bed)
    const z = getZoneNumber(e.zone)
    if (b && b > maxBed) maxBed = b
    if (z && z > maxZone) maxZone = z
  }
  return { maxBed, maxZone }
}

export const processScoutingReport = (report: ScoutingReport): ProcessedScouting => {
  const meta = report.observation_metadata
  const allObsNames = meta?.all_observation_names ?? {}
  const metaTypes = meta?.active_observation_types ?? []

  const discovered = new Set<string>()
  const entries = report.scouting_entries ?? []
  for (const e of entries) {
    for (const key of Object.keys(e)) {
      if (
        key.endsWith("_scouting_entry") &&
        Array.isArray(e[key]) &&
        (e[key] as unknown[]).length > 0
      ) {
        discovered.add(key)
      }
    }
  }
  const activeObservationTypes = Array.from(new Set([...metaTypes, ...discovered]))

  const dataMap = new Map<string, ProcessedObservation[]>()
  const observationsByType: Record<string, Set<string>> = {}
  for (const t of activeObservationTypes) observationsByType[t] = new Set()

  const stagesInGreenhouse = new Set<string>(["N/A"])
  const sectionsInGreenhouse = new Set<string>(["N/A"])

  for (const entry of entries) {
    const bed = parseBedNumber(entry.bed)
    const zone = getZoneNumber(entry.zone)
    if (!bed || !zone) continue
    const key = `${bed}-${zone}`
    if (!dataMap.has(key)) dataMap.set(key, [])
    const cell = dataMap.get(key)!

    for (const obsType of activeObservationTypes) {
      const arr = (entry[obsType] as unknown[]) || []
      for (const raw of arr) {
        const obs = raw as {
          name?: string
          count?: number
          stage?: string
          symbol?: string
          color?: string
          plant_section?: string
        }
        if (!obs?.name) continue
        observationsByType[obsType].add(obs.name)
        const stage = obs.stage || "N/A"
        const section = obs.plant_section || "N/A"
        stagesInGreenhouse.add(stage)
        sectionsInGreenhouse.add(section)
        cell.push({
          type: obsType,
          name: obs.name,
          count: obs.count ?? 1,
          stage,
          symbol: obs.symbol || "",
          color: obs.color || "#cccccc",
          plant_section: section,
        })
      }
    }
  }

  // Include metadata-only observations (visible but not in current scouting)
  for (const t of activeObservationTypes) {
    const list = allObsNames[t] || []
    for (const item of list) {
      const name = typeof item === "string" ? item : item?.name
      if (name) observationsByType[t].add(name)
    }
  }

  // Sort observations in each cell by name
  for (const [key, obs] of dataMap) {
    dataMap.set(
      key,
      [...obs].sort((a, b) => a.name.localeCompare(b.name)),
    )
  }

  // Variety groups by base name
  const varietyGroups = new Map<string, Set<string>>()
  for (const v of report.varieties ?? []) {
    const full = (v.name || "").trim()
    if (!full) continue
    const base = normalizeVarietyName(full)
    if (!varietyGroups.has(base)) varietyGroups.set(base, new Set())
    varietyGroups.get(base)!.add(full)
  }

  return {
    dataMap,
    observationsByType,
    stagesInGreenhouse,
    sectionsInGreenhouse,
    activeObservationTypes,
    varietyGroups,
  }
}

export const getGroupedVarietyNames = (
  selectedBase: string,
  groups: Map<string, Set<string>>,
): string[] => {
  if (!selectedBase) return []
  const set = groups.get(selectedBase)
  if (!set || set.size === 0) return [selectedBase]
  return Array.from(set)
}

export const getRequirementForVarietyGroup = (
  row: SusceptibilityRow | undefined,
  selectedBase: string,
  groups: Map<string, Set<string>>,
): "high" | "moderate" | "low" | null => {
  if (!row?.requirement_by_variety || !selectedBase) return null
  const levels = getGroupedVarietyNames(selectedBase, groups)
    .map((v) => row.requirement_by_variety?.[v])
    .filter((l): l is "high" | "moderate" | "low" => !!l && l !== "unknown")
  if (levels.includes("high")) return "high"
  if (levels.includes("moderate")) return "moderate"
  if (levels.includes("low")) return "low"
  return null
}

export const hasSusceptibilityForVariety = (
  variety: string,
  susceptibility: SusceptibilityRow[],
  groups: Map<string, Set<string>>,
): boolean => {
  if (!variety || susceptibility.length === 0) return false
  return susceptibility.some((row) => !!getRequirementForVarietyGroup(row, variety, groups))
}

// Parse "1, 3, 5-8, 12" into a Set of bed numbers as strings
export const parseBedRange = (s: string): Set<string> => {
  const out = new Set<string>()
  for (const seg of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const range = seg.match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const a = Number.parseInt(range[1], 10)
      const b = Number.parseInt(range[2], 10)
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(String(i))
    } else if (/^\d+$/.test(seg)) {
      out.add(seg)
    }
  }
  return out
}
