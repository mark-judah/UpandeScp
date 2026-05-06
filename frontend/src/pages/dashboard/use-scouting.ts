import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  scoutingApi,
  rangeFromWeeks,
  getIsoWeekString,
  type ScoutingPayload,
} from "@/lib/scouting-api"
import { FrappeError } from "@/lib/frappe"

export interface ScoutingFilters {
  weekFrom: string
  weekTo: string
  greenhouse: string | null
}

export interface ScoutingState {
  filters: ScoutingFilters
  setFilters: (next: Partial<ScoutingFilters>) => void
  payload: ScoutingPayload | null
  loading: boolean
  error: string | null
  refresh: () => void
  greenhouses: string[]
}

const todayWeek = (): string => getIsoWeekString(new Date())

export function useScouting(initialGreenhouse: string | null = null): ScoutingState {
  const [filters, setFiltersRaw] = useState<ScoutingFilters>({
    weekFrom: todayWeek(),
    weekTo: todayWeek(),
    greenhouse: initialGreenhouse,
  })
  const [greenhouses, setGreenhouses] = useState<string[]>([])
  const [payload, setPayload] = useState<ScoutingPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshIdx, setRefreshIdx] = useState(0)

  const setFilters = (next: Partial<ScoutingFilters>) =>
    setFiltersRaw((cur) => ({ ...cur, ...next }))

  const refresh = () => setRefreshIdx((n) => n + 1)

  // Load greenhouse list + default to latest scouting week on first mount.
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      scoutingApi.listScoutedGreenhouses(),
      scoutingApi.latestScoutingDate(),
    ]).then(([ghRes, latestRes]) => {
      if (cancelled) return
      if (ghRes.status === "fulfilled") setGreenhouses(ghRes.value)
      if (latestRes.status === "fulfilled" && latestRes.value) {
        const date = new Date(`${latestRes.value}T00:00:00Z`)
        if (!Number.isNaN(date.getTime())) {
          const week = getIsoWeekString(date)
          setFiltersRaw((cur) => ({ ...cur, weekFrom: week, weekTo: week }))
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Fetch entries whenever filters or refresh change.
  const range = useMemo(() => rangeFromWeeks(filters.weekFrom, filters.weekTo), [filters.weekFrom, filters.weekTo])

  useEffect(() => {
    if (!range) return
    let cancelled = false
    setLoading(true)
    setError(null)
    scoutingApi
      .getCompleteScoutingEntries({
        from_date: range.from,
        to_date: range.to,
        greenhouse: filters.greenhouse ?? null,
      })
      .then((p) => {
        if (cancelled) return
        setPayload(p)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg =
          err instanceof FrappeError ? err.message : "Failed to load scouting data"
        setError(msg)
        toast.error(msg)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [range, filters.greenhouse, refreshIdx])

  return {
    filters,
    setFilters,
    payload,
    loading,
    error,
    refresh,
    greenhouses,
  }
}
