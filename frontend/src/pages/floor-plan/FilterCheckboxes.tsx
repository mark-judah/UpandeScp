import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { PLANT_SECTIONS } from "./heatmap-utils"
import type { ObservationMetadata } from "@/lib/scp-api"

interface FilterCheckboxesProps {
  metadata: ObservationMetadata | undefined
  activeObservationTypes: string[]
  observationsByType: Record<string, Set<string>>
  stages: Set<string>
  sections: Set<string>
  hasSusceptibility: boolean
  state: FilterState
  onChange: (state: FilterState) => void
  thresholdMessage?: string
}

export interface FilterState {
  observationsByType: Record<string, string[]>
  stages: string[]
  sections: string[]
  requirements: Array<"low" | "moderate" | "high">
}

export function emptyFilterState(): FilterState {
  return { observationsByType: {}, stages: [], sections: [], requirements: [] }
}

export function FilterCheckboxes(props: FilterCheckboxesProps) {
  const {
    metadata,
    activeObservationTypes,
    observationsByType,
    stages,
    sections,
    hasSusceptibility,
    state,
    onChange,
    thresholdMessage,
  } = props

  const labels = metadata?.type_labels ?? {}

  const toggleObs = (type: string, name: string) => {
    const cur = state.observationsByType[type] ?? []
    const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]
    onChange({
      ...state,
      observationsByType: { ...state.observationsByType, [type]: next },
    })
  }
  const toggleStage = (stage: string) => {
    const next = state.stages.includes(stage)
      ? state.stages.filter((s) => s !== stage)
      : [...state.stages, stage]
    onChange({ ...state, stages: next })
  }
  const toggleSection = (section: string) => {
    const next = state.sections.includes(section)
      ? state.sections.filter((s) => s !== section)
      : [...state.sections, section]
    onChange({ ...state, sections: next })
  }
  const toggleRequirement = (r: "low" | "moderate" | "high") => {
    const next = state.requirements.includes(r)
      ? state.requirements.filter((x) => x !== r)
      : [...state.requirements, r]
    onChange({ ...state, requirements: next })
  }

  const typeLabelFor = (t: string) =>
    labels[t] ||
    t
      .replace(/_scouting_entry$/, "")
      .replace(/_entry$/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase())

  return (
    <div className="space-y-4">
      {activeObservationTypes.map((t) => {
        const names = Array.from(observationsByType[t] ?? []).sort()
        const active = state.observationsByType[t] ?? []
        return (
          <div key={t}>
            <Label className="text-xs font-semibold uppercase text-muted-foreground">
              {typeLabelFor(t)}
            </Label>
            {names.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground italic">
                No observations available
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                {names.map((name) => (
                  <label
                    key={`${t}-${name}`}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
                  >
                    <Checkbox
                      checked={active.includes(name)}
                      onCheckedChange={() => toggleObs(t, name)}
                    />
                    {name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <Separator />

      <div>
        <Label className="text-xs font-semibold uppercase text-muted-foreground">Stages</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {Array.from(stages).map((stage) => (
            <label
              key={stage}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
            >
              <Checkbox
                checked={state.stages.includes(stage)}
                onCheckedChange={() => toggleStage(stage)}
              />
              {stage}
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label className="text-xs font-semibold uppercase text-muted-foreground">
          Plant Sections
        </Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {PLANT_SECTIONS.map((section) => {
            const present = sections.has(section)
            return (
              <label
                key={section}
                className={
                  "flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted " +
                  (present ? "" : "opacity-40")
                }
              >
                <Checkbox
                  checked={state.sections.includes(section)}
                  onCheckedChange={() => toggleSection(section)}
                  disabled={!present}
                />
                {section}
              </label>
            )
          })}
        </div>
      </div>

      <div>
        <Label className="text-xs font-semibold uppercase text-muted-foreground">
          Chemical Requirements
        </Label>
        {thresholdMessage && (
          <p className="mt-1 text-xs text-amber-600">{thresholdMessage}</p>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground">
          Based on zones covered vs total zones
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {(["low", "moderate", "high"] as const).map((r) => (
            <label
              key={r}
              className={
                "flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted " +
                (hasSusceptibility ? "" : "opacity-40")
              }
            >
              <Checkbox
                checked={state.requirements.includes(r)}
                onCheckedChange={() => toggleRequirement(r)}
                disabled={!hasSusceptibility}
              />
              {r.charAt(0).toUpperCase() + r.slice(1)}
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
