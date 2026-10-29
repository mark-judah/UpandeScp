/**
 * Single block picker in the header-pill style, with each block's crop picked out
 * beside its name and blocks grouped by pivot or section. Used where scouting picks
 * a block, so on a pivot the crop the slice is growing is the first thing read.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CropChip } from "@/components/CropChip";
import { HEADER_PILL } from "@/components/header-controls";
import { cn } from "@/lib/utils";
import type { BlockCrop } from "@/lib/open-field-api";

const short = (n: string) => n.replace(/\s+-\s+[A-Z0-9]{2,5}$/, "");

export function BlockSelect({
  label, placeholder, value, onChange, options, crops, className,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  crops: Record<string, BlockCrop | undefined>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const groups = new Map<string, string[]>();
  for (const o of options) {
    const g = crops[o]?.group ?? "";
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true })));
  const chosen = value ? crops[value] : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button" aria-label={label}
          className={cn(HEADER_PILL, "inline-flex items-center justify-between", className)}
        >
          <span className="truncate">{value ? short(value) : placeholder}</span>
          {chosen?.crop_label && <CropChip crop={chosen.crop_label} />}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <div role="listbox" aria-label={label} className="max-h-80 overflow-y-auto">
          {ordered.map(([g, names]) => (
            <div key={g || "other"}>
              {g && (
                <div className="px-2 pb-0.5 pt-2 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {short(g)}
                </div>
              )}
              {names.map((n) => (
                <button
                  key={n} type="button" role="option" aria-selected={n === value}
                  onClick={() => { onChange(n); setOpen(false); }}
                  className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", n === value && "bg-muted")}
                >
                  <span className="flex-1 truncate">{short(n)}</span>
                  <CropChip crop={crops[n]?.crop_label} />
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
