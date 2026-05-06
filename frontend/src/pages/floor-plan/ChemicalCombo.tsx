import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { ChemicalOption } from "@/lib/scp-api"

interface ChemicalComboProps {
  value: string
  itemCode: string
  options: ChemicalOption[]
  onSelect: (item: ChemicalOption) => void
  placeholder?: string
  disabled?: boolean
}

export function ChemicalCombo({
  value,
  itemCode,
  options,
  onSelect,
  placeholder = "Chemical",
  disabled,
}: ChemicalComboProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [])

  const filtered = options.filter((o) =>
    `${o.item_name} ${o.item_code}`.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={!!itemCode && !open}
        className={cn(itemCode && !open && "bg-muted/40")}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-40 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
          {filtered.slice(0, 50).map((c) => (
            <button
              type="button"
              key={c.item_code}
              onClick={() => {
                onSelect(c)
                setQuery(c.item_name)
                setOpen(false)
              }}
              className="flex w-full flex-col items-start px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="font-medium">{c.item_name}</span>
              <span className="text-xs text-muted-foreground">{c.item_code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
