/**
 * The block filter of the Application Floor Plan: one pill, like the observation picker,
 * that opens the grouped block list. Choose all blocks, a pivot or section (its tri-state
 * checkbox), or individual blocks. The picks are the plan's blocks: the map highlights them
 * and the plan panel lists them.
 *
 * The pill reads "Select blocks", the single block's name, a group's name when exactly that
 * group is picked, "All blocks", or "N blocks".
 */
import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { BlockMultiPicker } from "@/components/spray-plan/BlockMultiPicker";
import type { OpenFieldBlock, OpenFieldGroup } from "@/lib/open-field";
import { cn } from "@/lib/utils";

export function blockPillText(groups: OpenFieldGroup[], selected: string[]): string {
  const all = groups.flatMap((g) => g.blocks);
  const sel = all.filter((b) => selected.includes(b.name));
  if (!all.length) return "No blocks";
  if (!sel.length) return "Select blocks";
  if (sel.length === all.length) return all.length === 1 ? all[0].label : "All blocks";
  if (sel.length === 1) return sel[0].label;
  const whole = groups.find((g) => g.name && g.blocks.length === sel.length && g.blocks.every((b) => selected.includes(b.name)));
  return whole ? whole.label : `${sel.length} blocks`;
}

export function BlockFilterPill({
  groups, selected, onChange, loading, focus, rowExtra, className,
}: {
  groups: OpenFieldGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  focus?: string | null;
  rowExtra?: (block: OpenFieldBlock) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const everything = useMemo(() => groups.flatMap((g) => g.blocks.map((b) => b.name)), [groups]);
  const allOn = everything.length > 0 && everything.every((n) => selected.includes(n));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Blocks"
          aria-haspopup="dialog"
          disabled={!groups.length && !loading}
          className={cn(
            "inline-flex min-w-0 max-w-[16rem] items-center justify-between border text-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            HEADER_PILL,
            className,
          )}
        >
          <span className="truncate">{loading ? "Blocks…" : blockPillText(groups, selected)}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(26rem,92vw)] p-2">
        <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm font-medium hover:bg-muted">
          <Checkbox
            checked={allOn}
            onCheckedChange={() => onChange(allOn ? [] : everything)}
            aria-label="Select all blocks"
          />
          Select all blocks
        </label>
        <BlockMultiPicker groups={groups} selected={selected} onChange={onChange} loading={loading} focus={focus} rowExtra={rowExtra} />
      </PopoverContent>
    </Popover>
  );
}
