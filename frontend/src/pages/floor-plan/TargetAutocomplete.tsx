import { useEffect, useRef, useState } from "react"
import { X, Plus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { TargetOption } from "@/lib/scp-api"

interface TargetAutocompleteProps {
  options: TargetOption[]
  selected: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function TargetAutocomplete({
  options,
  selected,
  onChange,
  placeholder = "Search pests & diseases or type a custom target…",
}: TargetAutocompleteProps) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  const remove = (target: string) => onChange(selected.filter((t) => t !== target))

  const add = (target: string) => {
    const t = target.trim()
    if (!t) return
    if (selected.includes(t)) return
    onChange([...selected, t])
  }

  const selectedSet = new Set(selected)
  const filtered = options.filter(
    (o) =>
      !selectedSet.has(o.name) && o.name.toLowerCase().includes(query.toLowerCase()),
  )
  const showCustom =
    query.trim() &&
    !filtered.some((m) => m.name.toLowerCase() === query.trim().toLowerCase()) &&
    !selectedSet.has(query.trim())

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      if (query.trim()) {
        add(query)
        setQuery("")
        setOpen(false)
      }
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1 pr-1 font-normal">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                className="rounded-sm p-0.5 hover:bg-muted"
                onClick={() => remove(t)}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
      />

      {open && (filtered.length > 0 || showCustom) && (
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
          {filtered.slice(0, 20).map((opt) => (
            <button
              key={opt.name}
              type="button"
              onClick={() => {
                add(opt.name)
                setQuery("")
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent",
              )}
            >
              <span>{opt.name}</span>
              <Badge variant="outline" className="font-normal">
                {opt.type}
              </Badge>
            </button>
          ))}
          {showCustom && (
            <button
              type="button"
              onClick={() => {
                add(query)
                setQuery("")
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm hover:bg-accent"
            >
              <Plus className="size-3.5" />
              Add &ldquo;{query.trim()}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  )
}
