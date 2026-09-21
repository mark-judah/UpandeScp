import { useMemo, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn, isoWeek, parseYmd, ymd } from "@/lib/utils";

export interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (next: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
  /**
   * ``pill`` (default) is the borderless soft-shadow chip used across scouting,
   * reports and maps. ``field`` gives it a bordered box that matches the Select
   * dropdowns on form pages (see the Application Plan scheduling row).
   */
  variant?: "pill" | "field";
}

/** Borderless soft-shadow chip — the app-wide default look. */
const PILL_TRIGGER =
  "h-9 gap-2 rounded-full border-transparent bg-card px-4 text-xs font-medium tabular-nums text-foreground shadow-[var(--sd-shadow-1)] hover:bg-card hover:text-foreground hover:shadow-[var(--sd-shadow-2)] [&>svg]:text-[var(--sd-quiet)]";

/** Bordered box matching the Select dropdown triggers on form pages. */
const FIELD_TRIGGER =
  "h-9 gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium tabular-nums text-foreground shadow-sm hover:bg-background hover:text-foreground [&>svg]:text-[var(--sd-quiet)]";

/**
 * Compact shadcn-style date picker built on react-day-picker. Shows the ISO
 * week column on the left edge of the calendar — useful for crop scouting
 * which schedules by week — and renders the value as
 * ``YYYY-MM-DD · Wxx`` in the trigger button.
 */
export function DatePicker({
  value,
  onChange,
  label,
  className,
  disabled,
  variant = "pill",
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const date = useMemo(() => (value ? parseYmd(value) : undefined), [value]);
  const display = useMemo(() => {
    if (!date) return "Pick a date";
    const wk = isoWeek(date);
    return `${value} · W${wk}`;
  }, [date, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(
            variant === "field" ? FIELD_TRIGGER : PILL_TRIGGER,
            !date && "text-muted-foreground",
            className,
          )}
          aria-label={label}
        >
          <CalendarIcon className="h-3.5 w-3.5" />
          {display}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => {
            if (d) {
              onChange(ymd(d));
              setOpen(false);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
