/** Searchable pill for the pest or disease the heat field shows — one at a time. */
import { SearchInput } from "@/components/SearchInput";
import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { cn } from "@/lib/utils";
import type { ObsOption } from "@/lib/pest-heat";

export const obsKey = (o: { kind: string; name: string }) => `${o.kind}|${o.name}`;

export function ObservationPicker({
  options,
  value,
  onChange,
}: {
  options: ObsOption[];
  value: ObsOption | null;
  onChange: (o: ObsOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.name.toLowerCase().includes(s)) : options;
  }, [options, q]);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(HEADER_PILL, "max-w-[16rem]")} aria-label="Observation" disabled={!options.length}>
          <span className="truncate">{value ? value.name : "No observations"}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <SearchInput autoFocus className="mb-1.5" value={q} onChange={setQ} placeholder="Search pests and diseases" />
        <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Pests and diseases">
          {shown.length ? (
            shown.map((o) => (
              <button
                key={obsKey(o)}
                type="button"
                role="option"
                aria-selected={!!value && obsKey(value) === obsKey(o)}
                onClick={() => { onChange(o); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <Check className={cn("h-3.5 w-3.5 shrink-0", value && obsKey(value) === obsKey(o) ? "opacity-100" : "opacity-0")} />
                <span className="flex-1 truncate">{o.name}</span>
                <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{o.kind}</span>
                <span className="w-9 text-right tabular-nums text-muted-foreground">{o.count}</span>
              </button>
            ))
          ) : (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">No match</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
