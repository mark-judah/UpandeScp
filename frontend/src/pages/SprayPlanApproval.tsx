import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CheckCircle2, ClipboardX, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

import { currentUser, FrappeError } from "@/lib/frappe"
import { scpApi } from "@/lib/scp-api"

import { ActionBar } from "./spray-plan-approval/ActionBar"
import { FiltersBar } from "./spray-plan-approval/FiltersBar"
import { HeaderStats } from "./spray-plan-approval/HeaderStats"
import { ProgressPanel } from "./spray-plan-approval/ProgressPanel"
import { StatusTabs } from "./spray-plan-approval/StatusTabs"
import { WorkOrderTable } from "./spray-plan-approval/WorkOrderTable"
import { todayISO } from "./spray-plan-approval/utils"
import { useApprovalRunner } from "./spray-plan-approval/useApprovalRunner"
import type {
  SpaFilters,
  StatusTab,
  WorkOrder,
} from "./spray-plan-approval/types"

type DataState =
  | { kind: "loading" }
  | { kind: "ready"; hasFilter: boolean }
  | { kind: "error"; message: string }

const initialFilters: SpaFilters = {
  fromDate: todayISO(),
  toDate: todayISO(),
  farm: "",
  greenhouse: "",
}

export function SprayPlanApproval() {
  const [filters, setFilters] = useState<SpaFilters>(initialFilters)
  const [farmsByGh, setFarmsByGh] = useState<Record<string, string[]>>({})
  const [farms, setFarms] = useState<string[]>([])
  const [allWos, setAllWos] = useState<WorkOrder[]>([])
  const [tab, setTabState] = useState<StatusTab>("pending")
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [dataState, setDataState] = useState<DataState>({ kind: "loading" })
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false)

  // Latest filters used during a load — used in empty-state messages so they
  // reflect what was actually requested, not what's in the inputs now.
  const lastFiltersRef = useRef<SpaFilters>(initialFilters)

  const reloadForRunner = useCallback(() => {
    loadWorkOrders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const runner = useApprovalRunner(reloadForRunner)

  const updateFilters = useCallback((next: Partial<SpaFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }))
  }, [])

  const clearFilters = useCallback(() => {
    setFilters({ fromDate: "", toDate: "", farm: "", greenhouse: "" })
  }, [])

  const loadFarms = useCallback(async () => {
    try {
      const r = await scpApi.sprayPlan.getFarmsAndGreenhouses()
      setFarms(r.farms ?? [])
      setFarmsByGh(r.greenhouses_by_farm ?? {})
    } catch {
      // Silently fail — filters still work without farm list.
    }
  }, [])

  async function loadWorkOrders() {
    setDataState({ kind: "loading" })
    setChecked(new Set())
    setExpanded(new Set())
    setStopConfirmOpen(false)

    const args = {
      from_date: filters.fromDate || null,
      to_date: filters.toDate || null,
      farm: filters.farm || null,
      greenhouse: filters.greenhouse || null,
    }
    lastFiltersRef.current = { ...filters }
    const hasFilter = Boolean(
      args.from_date || args.to_date || args.farm || args.greenhouse,
    )

    try {
      const r = await scpApi.sprayPlan.getPendingWorkOrders(args)
      setAllWos(r.work_orders ?? [])
      setDataState({ kind: "ready", hasFilter })
    } catch (e) {
      const message =
        e instanceof FrappeError
          ? e.message
          : "Failed to load work orders. Check your connection or permissions."
      setDataState({ kind: "error", message })
    }
  }

  useEffect(() => {
    // Mount-time fetch — helpers update React state on completion, which the
    // lint rule flags but is the intended pattern here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFarms()
    loadWorkOrders()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const greenhousesForFarm = useMemo(
    () => (filters.farm ? farmsByGh[filters.farm] ?? [] : []),
    [filters.farm, farmsByGh],
  )

  const visibleWos = useMemo(() => {
    if (tab === "pending") return allWos.filter((w) => !w.is_forwarded)
    if (tab === "forwarded") return allWos.filter((w) => w.is_forwarded)
    return allWos
  }, [allWos, tab])

  const pendingCount = useMemo(
    () => allWos.filter((w) => !w.is_forwarded).length,
    [allWos],
  )
  const forwardedCount = allWos.length - pendingCount

  // Switch tabs: prune checked items that fall out of the visible set and
  // dismiss any pending stop-confirm. Done in the handler (not an effect) so
  // we don't trigger a cascading render.
  const setTab = useCallback(
    (next: StatusTab) => {
      setTabState((current) => {
        if (current === next) return current
        const visNames = new Set(
          (next === "pending"
            ? allWos.filter((w) => !w.is_forwarded)
            : next === "forwarded"
              ? allWos.filter((w) => w.is_forwarded)
              : allWos
          ).map((w) => w.name),
        )
        setChecked((prev) => {
          let changed = false
          const reduced = new Set<string>()
          prev.forEach((n) => {
            if (visNames.has(n)) reduced.add(n)
            else changed = true
          })
          return changed ? reduced : prev
        })
        setStopConfirmOpen(false)
        return next
      })
    },
    [allWos],
  )

  const emptyMessage = useMemo(() => {
    if (allWos.length === 0) {
      return dataState.kind === "ready" && dataState.hasFilter
        ? "No spray plans found for these filters."
        : "No pending spray plans found."
    }
    return tab === "pending"
      ? "No pending spray plans — all have been forwarded."
      : tab === "forwarded"
        ? "No forwarded plans in this selection."
        : "No work orders match the current filters."
  }, [allWos.length, dataState, tab])

  const toggleCheck = useCallback((name: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setStopConfirmOpen(false)
  }, [])

  const toggleAll = useCallback(
    (on: boolean) => {
      setChecked(on ? new Set(visibleWos.map((w) => w.name)) : new Set())
      if (!on) setStopConfirmOpen(false)
    },
    [visibleWos],
  )

  const toggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const onApprove = useCallback(() => {
    const names = Array.from(checked)
    if (!names.length) return
    runner.runApprove(names)
  }, [checked, runner])

  const onConfirmStop = useCallback(() => {
    const names = Array.from(checked)
    setStopConfirmOpen(false)
    if (!names.length) return
    runner.runStop(names)
  }, [checked, runner])

  const onShowAll = useCallback(() => {
    setFilters({ fromDate: "", toDate: "", farm: "", greenhouse: "" })
    // Defer load so the filter state is applied before the call.
    setTimeout(() => loadWorkOrders(), 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Inform user via toast on approve/stop blockers.
  const handleStopClick = useCallback(() => {
    if (checked.size === 0) {
      toast.warning("No work orders selected.")
      return
    }
    setStopConfirmOpen(true)
  }, [checked.size])

  return (
    <div className="flex min-h-svh flex-col bg-muted/30">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-5" />
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">
            Spray Plan Approval
          </h1>
          <HeaderStats
            pendingCount={pendingCount}
            forwardedCount={forwardedCount}
          />
        </div>
        <div className="hidden text-sm text-muted-foreground sm:block">
          {currentUser()}
        </div>
      </header>

      <FiltersBar
        filters={filters}
        farms={farms}
        greenhouses={greenhousesForFarm}
        busy={runner.busy || dataState.kind === "loading"}
        onChange={updateFilters}
        onLoad={loadWorkOrders}
        onClear={clearFilters}
      />

      <StatusTabs
        active={tab}
        pendingCount={pendingCount}
        forwardedCount={forwardedCount}
        onChange={setTab}
      />

      <main className="flex-1 p-4 pb-24 sm:p-6 sm:pb-28">
        {dataState.kind === "loading" && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Loading work orders…</p>
          </div>
        )}

        {dataState.kind === "error" && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-destructive">
            <CheckCircle2 className="size-10 rotate-45 text-destructive/70" />
            <p className="text-sm">{dataState.message}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadWorkOrders}
            >
              Retry
            </Button>
          </div>
        )}

        {dataState.kind === "ready" && visibleWos.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
            <ClipboardX className="size-10 text-muted-foreground/50" />
            <p className="text-sm">{emptyMessage}</p>
            <Button type="button" variant="ghost" size="sm" onClick={onShowAll}>
              Show All Dates
            </Button>
          </div>
        )}

        {dataState.kind === "ready" && visibleWos.length > 0 && (
          <WorkOrderTable
            wos={visibleWos}
            checked={checked}
            expanded={expanded}
            onToggleCheck={toggleCheck}
            onToggleAll={toggleAll}
            onToggleExpand={toggleExpand}
          />
        )}
      </main>

      <ActionBar
        selectedCount={checked.size}
        busy={runner.busy}
        stopConfirmOpen={stopConfirmOpen}
        onApprove={onApprove}
        onStopClick={handleStopClick}
        onConfirmStop={onConfirmStop}
        onDismissStop={() => setStopConfirmOpen(false)}
      />

      <ProgressPanel state={runner.state} onClose={runner.close} />
    </div>
  )
}
