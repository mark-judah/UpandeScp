import { useMemo } from "react"
import { cn } from "@/lib/utils"
import type { SusceptibilityRow } from "@/lib/scp-api"
import {
  TYPE_MAP,
  getRequirementForVarietyGroup,
  type ProcessedObservation,
} from "./heatmap-utils"

interface HeatmapGridProps {
  numBeds: number
  zonesPerBed: number
  bedNumbering: "Top to Bottom" | "Bottom to Top"
  zoneNumbering: "Right to Left" | "Left to Right"
  dataMap: Map<string, ProcessedObservation[]>
  activeObservationsByType: Record<string, string[]>
  activeStages: string[]
  activeSections: string[]
  activeRequirements: Array<"low" | "moderate" | "high">
  selectedVariety: string
  varietyGroups: Map<string, Set<string>>
  susceptibility: SusceptibilityRow[]
}

interface Cell {
  bed: number
  zone: number
  observations: ProcessedObservation[]
  inFilterCount: number
  highestAlert: 0 | 1 | 2 | 3
}

export function HeatmapGrid({
  numBeds,
  zonesPerBed,
  bedNumbering,
  zoneNumbering,
  dataMap,
  activeObservationsByType,
  activeStages,
  activeSections,
  activeRequirements,
  selectedVariety,
  varietyGroups,
  susceptibility,
}: HeatmapGridProps) {
  const zones = useMemo(
    () =>
      zoneNumbering === "Right to Left"
        ? Array.from({ length: zonesPerBed }, (_, i) => zonesPerBed - i)
        : Array.from({ length: zonesPerBed }, (_, i) => i + 1),
    [zonesPerBed, zoneNumbering],
  )

  const beds = useMemo(
    () =>
      bedNumbering === "Top to Bottom"
        ? Array.from({ length: numBeds }, (_, i) => numBeds - i)
        : Array.from({ length: numBeds }, (_, i) => i + 1),
    [numBeds, bedNumbering],
  )

  const cells: Cell[] = useMemo(() => {
    const out: Cell[] = []
    // Iterate visible row order: top bed first, then zones across that bed
    for (const bed of beds) {
      for (const zone of zones) {
        const key = `${bed}-${zone}`
        const observations = dataMap.get(key) ?? []
        let inFilter = 0
        let highest: 0 | 1 | 2 | 3 = 0
        for (const obs of observations) {
          const obsTypeActive = activeObservationsByType[obs.type] ?? []
          const obsActive = obsTypeActive.includes(obs.name)
          const stageActive = obs.stage === "N/A" || activeStages.includes(obs.stage)
          const sectionActive =
            obs.plant_section === "N/A" || activeSections.includes(obs.plant_section)
          if (!(obsActive && stageActive && sectionActive)) continue
          inFilter++

          const obsTypeClean = TYPE_MAP[obs.type] ?? obs.type.replace("_scouting_entry", "")
          const sus = susceptibility.find(
            (s) => s.observation === obs.name && s.type === obsTypeClean,
          )
          const req = getRequirementForVarietyGroup(sus, selectedVariety, varietyGroups)
          if (sus && req && activeRequirements.includes(req)) {
            const lvl = req === "high" ? 3 : req === "moderate" ? 2 : 1
            if (lvl > highest) highest = lvl as 0 | 1 | 2 | 3
          }
        }
        out.push({ bed, zone, observations, inFilterCount: inFilter, highestAlert: highest })
      }
    }
    return out
  }, [
    beds,
    zones,
    dataMap,
    activeObservationsByType,
    activeStages,
    activeSections,
    activeRequirements,
    selectedVariety,
    varietyGroups,
    susceptibility,
  ])

  if (numBeds === 0 || zonesPerBed === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        Select a greenhouse to view the heatmap
      </div>
    )
  }

  return (
    <div className="overflow-auto rounded-md border">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `auto repeat(${zonesPerBed}, minmax(2rem, 1fr))`,
          minWidth: "fit-content",
        }}
      >
        {/* Top-left empty corner */}
        <div className="bg-muted/50" />
        {/* X axis (zones) */}
        {zones.map((z) => (
          <div
            key={`zh-${z}`}
            className="border-b border-l bg-muted/50 px-2 py-1 text-center text-xs font-medium"
          >
            Z{z}
          </div>
        ))}
        {/* Rows: bed label + cells */}
        {cells.length > 0 &&
          beds.map((bed) => (
            <BedRow
              key={`row-${bed}`}
              bed={bed}
              zones={zones}
              cells={cells.filter((c) => c.bed === bed)}
            />
          ))}
      </div>
    </div>
  )
}

function BedRow({ bed, zones, cells }: { bed: number; zones: number[]; cells: Cell[] }) {
  const byZone = new Map(cells.map((c) => [c.zone, c]))
  return (
    <>
      <div className="border-t bg-muted/50 px-2 py-1 text-center text-xs font-medium">
        B{bed}
      </div>
      {zones.map((z) => {
        const c = byZone.get(z)
        return <CellView key={`${bed}-${z}`} cell={c ?? { bed, zone: z, observations: [], inFilterCount: 0, highestAlert: 0 }} />
      })}
    </>
  )
}

function CellView({ cell }: { cell: Cell }) {
  const visible = cell.observations.filter((_, i) => i < 4)
  const overflow = cell.observations.length - visible.length

  const alertClass = {
    0: "",
    1: "ring-2 ring-yellow-400",
    2: "ring-2 ring-orange-500",
    3: "ring-2 ring-red-500",
  }[cell.highestAlert]

  const empty = cell.observations.length === 0
  const inFilter = cell.inFilterCount > 0

  const titleLines = [
    `Bed ${cell.bed}, Zone ${cell.zone}`,
    ...(cell.observations.length === 0
      ? ["No observations reported"]
      : cell.observations.map(
          (o) =>
            `${o.name} (${o.count}${o.stage && o.stage !== "N/A" ? " " + o.stage : ""}) — ${o.plant_section}`,
        )),
  ]

  return (
    <div
      title={titleLines.join("\n")}
      className={cn(
        "relative aspect-square min-h-8 border-b border-l p-0.5",
        empty ? "bg-muted/20" : inFilter ? "bg-card" : "bg-muted/40",
        alertClass,
      )}
    >
      <div className="grid h-full grid-cols-2 gap-0.5">
        {visible.map((o, i) => (
          <span
            key={i}
            className="rounded-sm"
            style={{ backgroundColor: o.color }}
            title={o.name}
          />
        ))}
        {overflow > 0 && (
          <span className="flex items-center justify-center rounded-sm bg-muted text-[10px] text-muted-foreground">
            +{overflow}
          </span>
        )}
      </div>
    </div>
  )
}
