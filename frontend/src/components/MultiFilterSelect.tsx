/**
 * A multi-select in the header pill style, the sibling of FilterSelect for filters that
 * hold several values (pests, the targets of a chemical). A pill that opens a popover of
 * checkable options; no native <select>.
 *
 * `compact` renders a smaller pill for use inside a table row.
 */
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { cn } from "@/lib/utils";

export function MultiFilterSelect({
  label,
  values,
  onChange,
  options,
  allLabel = "All",
  compact,
  invalid,
  className,
}: {
  /** accessible name, e.g. "Pests" */
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  options: string[];
  /** shown on the pill when nothing is picked */
  allLabel?: string;
  compact?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  const opts = [...new Set(options.filter(Boolean))];
  const toggle = (o: string) =>
    onChange(values.includes(o) ? values.filter((v) => v !== o) : [...values, o]);
  const summary = !values.length
    ? allLabel
    : values.length <= 2
      ? values.join(", ")
      : `${values.length} selected`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={cn(
            HEADER_PILL,
            "inline-flex items-center justify-between",
            compact && "h-7 min-w-[6rem] max-w-[14rem] px-3 text-[0.7rem]",
            invalid && "ring-1 ring-[var(--sd-data-red)]",
            className,
          )}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-h-72 w-64 overflow-auto p-2">
        {opts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Nothing to pick from.</div>
        ) : (
          <>
            {values.length > 0 && (
              <button
                type="button"
                className="mb-1 w-full rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted"
                onClick={() => onChange([])}
              >
                Clear
              </button>
            )}
            {opts.map((o) => (
              <label
                key={o}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
              >
                <Checkbox checked={values.includes(o)} onCheckedChange={() => toggle(o)} />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
