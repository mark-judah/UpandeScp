/**
 * A page filter dropdown in the header pill style (`HEADER_PILL`) — the one
 * every SCP page uses for farm, greenhouse, team, state and the like, so a
 * filter looks and opens the same wherever it is. Replaces native <select>s,
 * which drew the browser's own control and menu.
 *
 * `allLabel` adds an "All …" first option that stands for "" (Radix Select
 * cannot hold an empty value, so it travels as a sentinel inside).
 */
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { HEADER_PILL } from "@/components/header-controls";
import { cn } from "@/lib/utils";

const ALL = "__all__";

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  disabled,
  className,
  format,
}: {
  /** accessible name, e.g. "Farm" */
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: string[];
  allLabel?: string;
  disabled?: boolean;
  className?: string;
  /** how an option reads (defaults to itself) */
  format?: (option: string) => string;
}) {
  const opts = [...new Set(options.filter(Boolean))];
  return (
    <Select
      value={value ? value : allLabel ? ALL : undefined}
      onValueChange={(v) => onChange(v === ALL ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className={cn(HEADER_PILL, className)}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {opts.map((o) => (
          <SelectItem key={o} value={o}>
            {format ? format(o) : o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
