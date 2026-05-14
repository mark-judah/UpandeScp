import { useEffect, useState } from "react"

export type ViewId = "floor-plan" | "dashboard" | "spray-plan"

const HASHES: Record<ViewId, string> = {
  "floor-plan": "#floor-plan",
  dashboard: "#dashboard",
  "spray-plan": "#spray-plan",
}

export const viewHash = (v: ViewId): string => HASHES[v]

const fromHash = (raw: string): ViewId => {
  switch (raw) {
    case "#dashboard":
      return "dashboard"
    case "#spray-plan":
      return "spray-plan"
    case "#floor-plan":
    default:
      return "floor-plan"
  }
}

export function useView(): [ViewId, (v: ViewId) => void] {
  const [view, setView] = useState<ViewId>(() => fromHash(window.location.hash))

  useEffect(() => {
    const onHash = () => setView(fromHash(window.location.hash))
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  const navigate = (next: ViewId) => {
    if (window.location.hash !== HASHES[next]) {
      window.location.hash = HASHES[next]
    }
    setView(next)
  }

  return [view, navigate]
}
