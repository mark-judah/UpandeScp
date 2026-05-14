import { cn } from "@/lib/utils"
import type { StatusTab } from "./types"

interface Props {
  active: StatusTab
  pendingCount: number
  forwardedCount: number
  onChange: (next: StatusTab) => void
}

const items: { id: StatusTab; label: string; dotClass?: string }[] = [
  { id: "pending", label: "Pending", dotClass: "bg-amber-500" },
  { id: "forwarded", label: "Forwarded", dotClass: "bg-emerald-500" },
  { id: "all", label: "All" },
]

export function StatusTabs({ active, pendingCount, forwardedCount, onChange }: Props) {
  const countFor = (id: StatusTab) => {
    if (id === "pending") return pendingCount
    if (id === "forwarded") return forwardedCount
    return pendingCount + forwardedCount
  }

  return (
    <div className="flex gap-1 border-b bg-background px-4 sm:px-6">
      {items.map((it) => {
        const isActive = active === it.id
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onChange(it.id)}
            className={cn(
              "flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {it.dotClass && (
              <span className={cn("size-1.5 rounded-full", it.dotClass)} />
            )}
            <span>{it.label}</span>
            <span
              className={cn(
                "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {countFor(it.id)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
