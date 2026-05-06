import { useEffect, useMemo, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { DatePicker } from "@/components/DatePicker"

import { bootstrap, currentUser, FrappeError } from "@/lib/frappe"
import {
  scpApi,
  type ChemicalOption,
  type ScoutingReport,
  type TargetOption,
} from "@/lib/scp-api"

import { TargetAutocomplete } from "./floor-plan/TargetAutocomplete"
import { HeatmapGrid } from "./floor-plan/HeatmapGrid"
import { StockBalanceTable } from "./floor-plan/StockBalanceTable"
import { BomModal } from "./floor-plan/BomModal"
import { ValidationDialog } from "./floor-plan/ValidationDialog"
import { ChemicalCombo } from "./floor-plan/ChemicalCombo"
import {
  FilterCheckboxes,
  emptyFilterState,
  type FilterState,
} from "./floor-plan/FilterCheckboxes"
import {
  findMaxDimensions,
  hasSusceptibilityForVariety,
  parseBedRange,
  processScoutingReport,
  normalizeVarietyName,
  type ProcessedScouting,
} from "./floor-plan/heatmap-utils"

const SPRAY_TYPES = [
  "Full",
  "Under",
  "Top",
  "Full + Top",
  "Full + Under",
  "Outside",
  "Drench",
] as const

const SCOPES = ["Full Greenhouse", "Specific Variety", "Specific Bed(s)"] as const
const WATER_VOLUME_RATE = 1000

interface ChemRow {
  itemCode: string
  itemName: string
  rate: string
  uom: string
}

interface FormState {
  greenhouse: string
  variety: string
  scheduledApplicationTime: string
  sprayType: string
  selectedTargets: string[]
  kit: string
  scope: string
  bedNumbers: string
  selectedVarieties: string[]
  sprayTeam: string
  bomName: string
  waterPh: string
  waterHardness: string
}

const blankRow = (): ChemRow => ({ itemCode: "", itemName: "", rate: "", uom: "" })

const initialForm: FormState = {
  greenhouse: "",
  variety: "",
  scheduledApplicationTime: "",
  sprayType: "",
  selectedTargets: [],
  kit: "",
  scope: "",
  bedNumbers: "",
  selectedVarieties: [],
  sprayTeam: "",
  bomName: "",
  waterPh: "",
  waterHardness: "",
}

export function ApplicationFloorPlan() {
  const { greenhouses, sprayEquipment } = useMemo(bootstrap, [])

  const [form, setForm] = useState<FormState>(initialForm)
  const [report, setReport] = useState<ScoutingReport | null>(null)
  const [loadingReport, setLoadingReport] = useState(false)
  const [allTargets, setAllTargets] = useState<TargetOption[]>([])
  const [chemicals, setChemicals] = useState<ChemicalOption[]>([])
  const [uomCache, setUomCache] = useState<Record<string, string>>({})
  const [chemRows, setChemRows] = useState<ChemRow[]>([])
  const [filters, setFilters] = useState<FilterState>(emptyFilterState())
  const [sourceWarehouse, setSourceWarehouse] = useState<Record<string, string>>({})
  const [stockBalances, setStockBalances] = useState<Record<string, Record<string, number>>>({})
  const [stockWarehouses, setStockWarehouses] = useState<string[]>([])
  const [stockItemNameMap, setStockItemNameMap] = useState<Record<string, string>>({})
  const [stockStatus, setStockStatus] = useState<
    | { kind: "idle" }
    | { kind: "fetching"; codes: string[] }
    | { kind: "success"; codes: string[]; itemCount: number; warehouseCount: number }
    | { kind: "empty"; codes: string[] }
    | { kind: "error"; message: string; codes: string[] }
  >({ kind: "idle" })
  const [bomOpen, setBomOpen] = useState(false)
  const [validationDialog, setValidationDialog] = useState<{
    open: boolean
    errors: string[]
    payload: Record<string, unknown> | null
  }>({ open: false, errors: [], payload: null })
  const [submitting, setSubmitting] = useState(false)

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  // ---------- Process scouting report into derived structures ----------
  const processed = useMemo<ProcessedScouting | null>(
    () => (report ? processScoutingReport(report) : null),
    [report],
  )

  const varieties = useMemo(
    () => Array.from(processed?.varietyGroups.keys() ?? []).sort(),
    [processed],
  )
  const sprayTeams = report?.spray_team_team ?? []
  const boms = report?.boms ?? []
  const bomItems = report?.bom_items ?? []
  const bedData = report?.bed_data ?? []
  const susceptibility = report?.susceptibility ?? []

  // ---------- Initial filter state when scouting changes ----------
  useEffect(() => {
    if (!processed) {
      setFilters(emptyFilterState())
      return
    }
    const obs: Record<string, string[]> = {}
    for (const t of processed.activeObservationTypes) {
      // Default-on observations that exist in the current scouting data
      obs[t] = Array.from(processed.observationsByType[t] ?? [])
    }
    setFilters({
      observationsByType: obs,
      stages: Array.from(processed.stagesInGreenhouse),
      sections: Array.from(processed.sectionsInGreenhouse),
      requirements: [],
    })
  }, [processed])

  // ---------- Load scouting on greenhouse change ----------
  useEffect(() => {
    if (!form.greenhouse) {
      setReport(null)
      setChemRows([])
      return
    }
    let cancelled = false
    setLoadingReport(true)
    scpApi
      .getScoutingReport(form.greenhouse)
      .then((data) => {
        if (cancelled) return
        setReport(data)
        if (data?.all_chemicals) setChemicals(data.all_chemicals)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        toast.error(err instanceof FrappeError ? err.message : "Failed to load scouting report")
      })
      .finally(() => !cancelled && setLoadingReport(false))
    return () => {
      cancelled = true
    }
  }, [form.greenhouse])

  // ---------- Reset dependent fields on greenhouse change ----------
  useEffect(() => {
    setForm((f) => ({
      ...f,
      variety: "",
      bomName: "",
      waterPh: "",
      waterHardness: "",
      sprayTeam: "",
      selectedVarieties: [],
      bedNumbers: "",
    }))
    setChemRows([])
    setSourceWarehouse({})
    setStockBalances({})
    setStockWarehouses([])
  }, [form.greenhouse])

  // ---------- Load all-targets for autocomplete on first render ----------
  useEffect(() => {
    let cancelled = false
    scpApi
      .getTargetsForAutocomplete()
      .then((r) => {
        if (cancelled) return
        const targets = (r?.targets ?? []).filter((t) => t?.name)
        setAllTargets(targets)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  // ---------- Default selectedTargets from scouting when report loads ----------
  useEffect(() => {
    if (!processed) return
    const nameSet = new Set<string>()
    for (const set of Object.values(processed.observationsByType)) {
      for (const n of set) nameSet.add(n)
    }
    setForm((f) => ({
      ...f,
      selectedTargets: f.selectedTargets.length > 0 ? f.selectedTargets : Array.from(nameSet),
    }))
  }, [processed])

  // ---------- Stock balance refresh (debounced inline) ----------
  useEffect(() => {
    const codes = Array.from(new Set(chemRows.map((r) => r.itemCode.trim()).filter(Boolean)))
    if (codes.length === 0) {
      setStockBalances({})
      setStockWarehouses([])
      setStockItemNameMap({})
      setStockStatus({ kind: "idle" })
      return
    }
    let cancelled = false
    setStockStatus({ kind: "fetching", codes })
    const handle = window.setTimeout(async () => {
      try {
        // eslint-disable-next-line no-console
        console.log("[scp] getBomStockBalances request", { item_codes: codes })
        const r = await scpApi.getBomStockBalances(codes)
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.log("[scp] getBomStockBalances response", r)
        const balances = r?.stock_balances ?? {}
        const firstItem = Object.keys(balances)[0]
        const wh = firstItem ? Object.keys(balances[firstItem]) : []
        setStockBalances(balances)
        setStockWarehouses(wh)
        if (r?.item_uom_map) setUomCache((c) => ({ ...c, ...r.item_uom_map }))
        const nameMap: Record<string, string> = {}
        for (const c of chemicals) nameMap[c.item_code] = c.item_name
        for (const row of chemRows) {
          if (row.itemCode && row.itemName) nameMap[row.itemCode] = row.itemName
        }
        if (r?.item_name_map) Object.assign(nameMap, r.item_name_map)
        setStockItemNameMap(nameMap)
        setSourceWarehouse((cur) => {
          const next = { ...cur }
          for (const [code, whMap] of Object.entries(balances)) {
            if (next[code]) continue
            const [bestWh, bestQty] = Object.entries(whMap).reduce<[string | null, number]>(
              ([bw, bq], [w, q]) => (q > bq ? [w, q] : [bw, bq]),
              [null, -1],
            )
            if (bestWh && bestQty > 0) next[code] = bestWh
          }
          return next
        })
        if (Object.keys(balances).length === 0) {
          setStockStatus({ kind: "empty", codes })
        } else {
          setStockStatus({
            kind: "success",
            codes,
            itemCount: Object.keys(balances).length,
            warehouseCount: wh.length,
          })
        }
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof FrappeError ? e.message : String(e)
        setStockStatus({ kind: "error", message: msg, codes })
        toast.error(msg)
      }
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [chemRows, chemicals])

  // ---------- BOM selection populates rows ----------
  useEffect(() => {
    if (!form.bomName) {
      setChemRows([])
      return
    }
    const bom = boms.find((b) => b.name === form.bomName)
    if (!bom) return
    setForm((f) => ({
      ...f,
      waterPh: String(bom.custom_water_ph ?? ""),
      waterHardness: String(bom.custom_water_hardness ?? ""),
    }))
    const items = bomItems.filter((i) => i.parent === form.bomName)
    setChemRows(
      items.map((it) => ({
        itemCode: it.item_code,
        itemName: it.item_name ?? "",
        rate: String(it.qty ?? ""),
        uom: it.uom ?? "",
      })),
    )
    // Clear cache so auto-select runs fresh
    setSourceWarehouse({})
  }, [form.bomName, boms, bomItems])

  // ---------- Area / water volume calculation ----------
  const area = useMemo(() => {
    const totalBeds =
      new Set(bedData.map((d) => String(d?.bed ?? "").trim()).filter(Boolean)).size ||
      findMaxDimensions(report?.scouting_entries ?? []).maxBed
    let hectares = 0
    if (form.scope === "Full Greenhouse") {
      hectares = 1
    } else if (form.scope === "Specific Variety") {
      const selectedBaseSet = new Set(form.selectedVarieties)
      const matching = new Set<string>()
      for (const d of bedData) {
        if (selectedBaseSet.has(normalizeVarietyName(d.variety)) && d.bed) {
          matching.add(String(d.bed))
        }
      }
      hectares = matching.size && totalBeds ? matching.size / totalBeds : 0
    } else if (form.scope === "Specific Bed(s)") {
      const beds = parseBedRange(form.bedNumbers)
      hectares = beds.size && totalBeds ? beds.size / totalBeds : 0
    }
    const sqm = Math.round(hectares * 10000)
    const waterVolume = +(hectares * WATER_VOLUME_RATE).toFixed(2)
    return { hectares, sqm, waterVolume }
  }, [
    bedData,
    report?.scouting_entries,
    form.scope,
    form.selectedVarieties,
    form.bedNumbers,
  ])

  const hasSusc = useMemo(
    () => hasSusceptibilityForVariety(form.variety, susceptibility, processed?.varietyGroups ?? new Map()),
    [form.variety, susceptibility, processed],
  )

  const dimensions = useMemo(
    () => findMaxDimensions(report?.scouting_entries ?? []),
    [report?.scouting_entries],
  )

  // ---------- Chemical row helpers ----------
  const addRow = () => setChemRows((rs) => [...rs, blankRow()])
  const removeRow = (i: number) => setChemRows((rs) => rs.filter((_, idx) => idx !== i))
  const setRow = (i: number, patch: Partial<ChemRow>) =>
    setChemRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const handleSelectChemical = async (i: number, c: ChemicalOption) => {
    const cachedUom = uomCache[c.item_code] ?? c.uom ?? ""
    setRow(i, { itemCode: c.item_code, itemName: c.item_name, uom: cachedUom })
    if (!cachedUom) {
      try {
        const r = await scpApi.getChemicalUom(c.item_code)
        if (r?.uom) {
          setUomCache((u) => ({ ...u, [c.item_code]: r.uom }))
          setRow(i, { uom: r.uom })
        }
      } catch {
        // ignore
      }
    }
    // Drop cached source warehouse so auto-select picks freshly
    setSourceWarehouse((cur) => {
      const { [c.item_code]: _, ...rest } = cur
      return rest
    })
  }

  // ---------- Submission ----------
  const buildPayload = (): Record<string, unknown> => {
    const chemicalsWithSource = chemRows
      .filter((r) => r.itemCode && Number.parseFloat(r.rate) > 0)
      .map((r) => ({
        chemical: r.itemCode,
        item_name: r.itemName,
        application_rate: Number.parseFloat(r.rate),
        uom: r.uom,
        source_warehouse: sourceWarehouse[r.itemCode] ?? "",
      }))

    let custom_scope_value = ""
    if (form.scope === "Specific Variety") {
      custom_scope_value = form.selectedVarieties.join(",")
    } else if (form.scope === "Specific Bed(s)") {
      custom_scope_value = form.bedNumbers
    }

    return {
      custom_type: "Application Floor Plan",
      custom_greenhouse: form.greenhouse,
      custom_variety: form.variety,
      custom_targets: form.selectedTargets,
      custom_spray_type: form.sprayType,
      custom_kit: form.kit,
      custom_scope: form.scope,
      custom_scope_details: custom_scope_value,
      production_item: form.bomName,
      qty: 1,
      custom_water_ph: Number.parseFloat(form.waterPh) || 0,
      custom_water_hardness: Number.parseFloat(form.waterHardness) || 0,
      chemicals: chemicalsWithSource,
      custom_water_volume: area.waterVolume,
      custom_area: area.hectares,
      custom_spray_team: form.sprayTeam,
      custom_scheduled_application_time: form.scheduledApplicationTime || null,
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return

    const missing: string[] = []
    if (!form.greenhouse) missing.push("Greenhouse")
    if (form.selectedTargets.length === 0) missing.push("Targets")
    if (!form.scheduledApplicationTime) missing.push("Scheduled Application Date")
    if (!form.sprayType) missing.push("Spray Type")
    if (!form.kit) missing.push("Kit")
    if (!form.scope) missing.push("Scope")
    if (!form.sprayTeam) missing.push("Spray Team")
    if (!form.bomName) missing.push("BOM")
    if (missing.length) {
      toast.error(`Missing required fields: ${missing.join(", ")}`)
      return
    }

    const filledChems = chemRows.filter(
      (r) => r.itemCode && Number.parseFloat(r.rate) > 0,
    )
    if (filledChems.length === 0) return toast.error("Please add at least one chemical.")

    for (const c of filledChems) {
      const issues: string[] = []
      if (!c.uom) issues.push("UoM")
      if (Number.parseFloat(c.rate) > 10) issues.push("rate ≤ 10 per 1000L")
      if (!sourceWarehouse[c.itemCode]) issues.push("source warehouse")
      if (issues.length) {
        toast.error(`Chemical "${c.itemName || c.itemCode}" — ${issues.join(", ")}`)
        return
      }
    }

    if (!form.waterPh || !form.waterHardness) {
      toast.error("Please provide values for water pH and water hardness.")
      return
    }

    const payload = buildPayload()
    setSubmitting(true)
    try {
      const validation = await scpApi.validateGuidelines(payload)
      if (validation?.valid === true) {
        await createWorkOrder(payload)
      } else if (validation?.valid === false) {
        setValidationDialog({ open: true, errors: validation.errors ?? [], payload })
        setSubmitting(false)
      } else {
        toast.error("Unexpected response from validation server.")
        setSubmitting(false)
      }
    } catch (err) {
      toast.error(err instanceof FrappeError ? err.message : "Validation failed")
      setSubmitting(false)
    }
  }

  const createWorkOrder = async (payload: Record<string, unknown>) => {
    setSubmitting(true)
    try {
      const r = await scpApi.createApplicationWorkOrder(payload)
      if (r?.status === "success" && r.work_order_name) {
        toast.success(`Work Order ${r.work_order_name} created successfully!`)
        setTimeout(() => {
          window.location.href = `/app/work-order/${r.work_order_name}`
        }, 1500)
      } else {
        toast.error(`Error creating Work Order: ${r?.message || "Unknown error"}`)
      }
    } catch (err) {
      toast.error(err instanceof FrappeError ? err.message : "Work Order creation failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-5" />
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Application Floor Plan</h1>
          <Badge variant="secondary">React port</Badge>
          {report?.scouting_date && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Latest scouting: {formatDate(report.scouting_date)}
              {report.previous_scouting_date && (
                <> | Previous: {formatDate(report.previous_scouting_date)}</>
              )}
            </span>
          )}
        </div>
        <div className="hidden text-sm text-muted-foreground sm:block">
          Signed in as <span className="font-medium text-foreground">{currentUser()}</span>
        </div>
      </header>

      <main className="grid flex-1 gap-6 p-4 sm:p-6 lg:grid-cols-3">
        <form className="space-y-6 lg:col-span-1" onSubmit={handleSubmit}>
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldRow label="Greenhouse" required>
                <Select
                  value={form.greenhouse}
                  onValueChange={(v) => update("greenhouse", v ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select greenhouse" />
                  </SelectTrigger>
                  <SelectContent>
                    {greenhouses.map((g) => (
                      <SelectItem key={g.name} value={g.name}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
              <FieldRow label="Variety">
                <Select
                  value={form.variety}
                  onValueChange={(v) => update("variety", v ?? "")}
                  disabled={!varieties.length}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={varieties.length ? "Select variety" : "—"} />
                  </SelectTrigger>
                  <SelectContent>
                    {varieties.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </CardContent>
          </Card>

          {/* Filters */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Filters</CardTitle>
            </CardHeader>
            <CardContent>
              {!processed ? (
                <p className="text-sm text-muted-foreground">
                  {loadingReport
                    ? "Loading observations…"
                    : "Select a greenhouse to populate filters"}
                </p>
              ) : (
                <FilterCheckboxes
                  metadata={report?.observation_metadata}
                  activeObservationTypes={processed.activeObservationTypes}
                  observationsByType={processed.observationsByType}
                  stages={processed.stagesInGreenhouse}
                  sections={processed.sectionsInGreenhouse}
                  hasSusceptibility={hasSusc}
                  state={filters}
                  onChange={setFilters}
                  thresholdMessage={
                    !hasSusc && form.variety
                      ? "No susceptibility data for this variety."
                      : undefined
                  }
                />
              )}
            </CardContent>
          </Card>

          {/* Spray Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Spray Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldRow label="Scheduled Application Date" required>
                <DatePicker
                  value={form.scheduledApplicationTime}
                  onChange={(v) => update("scheduledApplicationTime", v)}
                />
              </FieldRow>

              <FieldRow label="Spray Type" required>
                <Select
                  value={form.sprayType}
                  onValueChange={(v) => update("sprayType", v ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {SPRAY_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <FieldRow label="Targets" required>
                <TargetAutocomplete
                  options={mergeTargetOptions(allTargets, processed)}
                  selected={form.selectedTargets}
                  onChange={(next) => update("selectedTargets", next)}
                />
              </FieldRow>

              <FieldRow label="Kit" required>
                <Select
                  value={form.kit}
                  onValueChange={(v) => update("kit", v ?? "")}
                  disabled={!sprayEquipment.length}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        sprayEquipment.length ? "Select kit" : "No equipment configured"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {sprayEquipment.map((e) => (
                      <SelectItem key={e.kit} value={e.kit}>
                        {e.kit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <FieldRow label="Scope" required>
                <Select
                  value={form.scope}
                  onValueChange={(v) => update("scope", v ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select scope" />
                  </SelectTrigger>
                  <SelectContent>
                    {SCOPES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              {form.scope === "Specific Bed(s)" && (
                <FieldRow
                  label="Bed Numbers"
                  help="Enter bed numbers or ranges, separated by commas (e.g. 1, 3, 5-8, 12)"
                >
                  <Input
                    value={form.bedNumbers}
                    onChange={(e) => update("bedNumbers", e.target.value)}
                    placeholder="1, 3, 5-8, 12"
                  />
                </FieldRow>
              )}

              {form.scope === "Specific Variety" && (
                <FieldRow label="Select Varieties">
                  <div className="space-y-2 rounded-md border p-3">
                    {varieties.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No varieties for this greenhouse
                      </p>
                    ) : (
                      varieties.map((v) => (
                        <label key={v} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={form.selectedVarieties.includes(v)}
                            onCheckedChange={() => {
                              const set = new Set(form.selectedVarieties)
                              if (set.has(v)) set.delete(v)
                              else set.add(v)
                              update("selectedVarieties", Array.from(set))
                            }}
                          />
                          {v}
                        </label>
                      ))
                    )}
                  </div>
                </FieldRow>
              )}

              <FieldRow label="Area to Spray (m²)">
                <Input value={area.sqm || ""} readOnly placeholder="—" />
              </FieldRow>

              <FieldRow label="Spray Team">
                <Select
                  value={form.sprayTeam}
                  onValueChange={(v) => update("sprayTeam", v ?? "")}
                  disabled={!sprayTeams.length}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={sprayTeams.length ? "Select team" : "—"} />
                  </SelectTrigger>
                  <SelectContent>
                    {sprayTeams.map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>
            </CardContent>
          </Card>

          {/* BOM */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bill of Materials</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FieldRow label="BOM" required>
                <div className="flex gap-2">
                  <Select
                    value={form.bomName}
                    onValueChange={(v) => update("bomName", v ?? "")}
                    disabled={!boms.length}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={boms.length ? "Select BOM" : "—"} />
                    </SelectTrigger>
                    <SelectContent>
                      {boms.map((b) => (
                        <SelectItem key={b.name} value={b.name}>
                          {b.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (!form.greenhouse) {
                        toast.error("Select a greenhouse first")
                        return
                      }
                      setBomOpen(true)
                    }}
                  >
                    + New
                  </Button>
                </div>
              </FieldRow>

              {form.bomName && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldRow label="Water PH">
                      <Input
                        value={form.waterPh}
                        onChange={(e) => update("waterPh", e.target.value)}
                      />
                    </FieldRow>
                    <FieldRow label="Water Hardness">
                      <Input
                        value={form.waterHardness}
                        onChange={(e) => update("waterHardness", e.target.value)}
                      />
                    </FieldRow>
                  </div>

                  <FieldRow label="Chemicals (Per 1000L)">
                    <div className="space-y-2 rounded-md border p-2">
                      {chemRows.length === 0 && (
                        <p className="px-1 py-2 text-xs text-muted-foreground">
                          No chemicals — add one below
                        </p>
                      )}
                      {chemRows.map((row, i) => (
                        <div
                          key={i}
                          className="grid grid-cols-[2fr_1fr_1fr_auto] items-center gap-2"
                        >
                          <ChemicalCombo
                            value={row.itemName}
                            itemCode={row.itemCode}
                            options={chemicals}
                            onSelect={(c) => handleSelectChemical(i, c)}
                          />
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={row.rate}
                            onChange={(e) => setRow(i, { rate: e.target.value })}
                            placeholder="Rate"
                          />
                          <Input value={row.uom} readOnly placeholder="UoM" />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label="Remove chemical"
                            onClick={() => removeRow(i)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={addRow}
                      >
                        <Plus className="mr-1 size-3.5" />
                        Add Chemical
                      </Button>
                    </div>
                  </FieldRow>

                  <FieldRow label="Volume (Litres/Ha)">
                    <Input value={area.waterVolume || ""} readOnly />
                  </FieldRow>
                </>
              )}
            </CardContent>
          </Card>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Submitting…" : "Create Spray Plan"}
          </Button>
        </form>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Scouting Heatmap</CardTitle>
            </CardHeader>
            <CardContent>
              <Separator className="mb-4" />
              {!form.greenhouse ? (
                <div className="flex h-72 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  Select a greenhouse to view the heatmap
                </div>
              ) : loadingReport ? (
                <div className="flex h-72 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  Loading scouting data…
                </div>
              ) : !processed ? (
                <div className="flex h-72 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  No scouting data found
                </div>
              ) : (
                <HeatmapGrid
                  numBeds={dimensions.maxBed}
                  zonesPerBed={dimensions.maxZone}
                  bedNumbering={report?.custom_bed_numbering ?? "Top to Bottom"}
                  zoneNumbering={report?.custom_zone_numbering ?? "Right to Left"}
                  dataMap={processed.dataMap}
                  activeObservationsByType={filters.observationsByType}
                  activeStages={filters.stages}
                  activeSections={filters.sections}
                  activeRequirements={filters.requirements}
                  selectedVariety={form.variety}
                  varietyGroups={processed.varietyGroups}
                  susceptibility={susceptibility}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Stock Balance</CardTitle>
            </CardHeader>
            <CardContent>
              <Separator className="mb-4" />
              <StockStatusStrip
                status={stockStatus}
                chemRowsCount={chemRows.length}
                bomSelected={!!form.bomName}
              />
              <StockBalanceTable
                balances={stockBalances}
                warehouses={stockWarehouses}
                itemNameMap={stockItemNameMap}
                sourceWarehouse={sourceWarehouse}
                onSourceChange={(code, wh) =>
                  setSourceWarehouse((cur) => ({ ...cur, [code]: wh }))
                }
              />
            </CardContent>
          </Card>
        </div>
      </main>

      <BomModal
        open={bomOpen}
        onOpenChange={setBomOpen}
        greenhouse={form.greenhouse}
        chemicals={chemicals}
        uomCache={uomCache}
        setUomCache={(next) => setUomCache(next)}
        onCreated={async (bomName) => {
          setBomOpen(false)
          // Refresh scouting to pull in the new BOM
          if (form.greenhouse) {
            const data = await scpApi.getScoutingReport(form.greenhouse)
            setReport(data)
          }
          update("bomName", bomName)
        }}
      />

      <ValidationDialog
        open={validationDialog.open}
        onOpenChange={(o) =>
          setValidationDialog((s) => ({ ...s, open: o }))
        }
        errors={validationDialog.errors}
        onBypass={() => {
          const payload = validationDialog.payload
          setValidationDialog({ open: false, errors: [], payload: null })
          if (payload) {
            toast.warning("Creating Work Order (Guidelines Bypassed)")
            createWorkOrder(payload)
          }
        }}
      />
    </div>
  )
}

type StockStatus =
  | { kind: "idle" }
  | { kind: "fetching"; codes: string[] }
  | { kind: "success"; codes: string[]; itemCount: number; warehouseCount: number }
  | { kind: "empty"; codes: string[] }
  | { kind: "error"; message: string; codes: string[] }

function StockStatusStrip({
  status,
  chemRowsCount,
  bomSelected,
}: {
  status: StockStatus
  chemRowsCount: number
  bomSelected: boolean
}) {
  let label = ""
  let tone = "text-muted-foreground"
  switch (status.kind) {
    case "idle":
      label = bomSelected
        ? `BOM selected with ${chemRowsCount} chemical row${chemRowsCount === 1 ? "" : "s"}, but no item codes resolved yet`
        : "Pick a BOM (or add chemicals) to populate stock balances"
      break
    case "fetching":
      label = `Fetching balances for ${status.codes.length} chemical(s)…`
      break
    case "success":
      label = `Showing ${status.itemCount} chemical(s) across ${status.warehouseCount} warehouse(s)`
      tone = "text-emerald-700 dark:text-emerald-400"
      break
    case "empty":
      label = `Backend returned no stock data for: ${status.codes.join(", ")}`
      tone = "text-amber-700 dark:text-amber-400"
      break
    case "error":
      label = `Error: ${status.message}`
      tone = "text-destructive"
      break
  }
  return <p className={"mb-3 text-xs " + tone}>{label}</p>
}

function FieldRow({
  label,
  required,
  help,
  children,
}: {
  label: string
  required?: boolean
  help?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

function formatDate(s: string): string {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

function mergeTargetOptions(
  base: TargetOption[],
  processed: ProcessedScouting | null,
): TargetOption[] {
  const byName = new Map<string, string>()
  for (const t of base) byName.set(t.name, t.type)
  if (processed) {
    for (const set of Object.values(processed.observationsByType)) {
      for (const name of set) if (!byName.has(name)) byName.set(name, "Scouting")
    }
  }
  return Array.from(byName.entries())
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

