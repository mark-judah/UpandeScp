import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Clock as ClockIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn, format12h, from12h, stepTime, to12h } from "@/lib/utils";

export interface TimePickerProps {
  value: string; // HH:mm (24-hour)
  onChange: (next: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}

/** Height (px) of a single odometer cell. Fixed px — not rem — so the roll
 *  translate stays exact regardless of the app's 85% root font-size. */
const CELL = 34;

/** Bordered box matching the Select dropdown triggers on form pages (and the
 *  DatePicker `field` variant) so date + time read as one control family. */
const FIELD_TRIGGER =
  "h-9 gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium tabular-nums text-foreground shadow-sm hover:bg-background hover:text-foreground [&>svg]:text-[var(--sd-quiet)]";

/**
 * A single odometer column. Renders every value in `values` stacked vertically
 * and slides the strip so the selected value sits centered in a 3-row window,
 * with faded neighbors above/below. Single-step changes animate; a wrap jump
 * (e.g. 11 -> 12) snaps instantly instead of sliding the long way. Respects
 * `prefers-reduced-motion`.
 */
function DigitColumn({ values, value }: { values: string[]; value: string }) {
  const index = Math.max(0, values.indexOf(value));
  const prevIndex = useRef(index);
  const isWrap = Math.abs(index - prevIndex.current) > 1;
  useEffect(() => {
    prevIndex.current = index;
  }, [index]);

  return (
    <div
      className="relative w-11 overflow-hidden"
      style={{
        height: CELL * 3,
        // Fade the top/bottom edges regardless of surface colour.
        maskImage:
          "linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent, #000 28%, #000 72%, transparent)",
      }}
    >
      <div
        className={cn(
          "flex flex-col will-change-transform",
          !isWrap &&
            "transition-transform duration-200 motion-reduce:transition-none",
        )}
        style={{
          transform: `translateY(${(1 - index) * CELL}px)`,
          transitionTimingFunction: "cubic-bezier(.22,.61,.36,1)",
        }}
      >
        {values.map((v, i) => (
          <div
            key={v}
            className={cn(
              "flex items-center justify-center text-base tabular-nums",
              i === index
                ? "font-semibold text-foreground"
                : "text-muted-foreground opacity-40",
            )}
            style={{ height: CELL }}
          >
            {v}
          </div>
        ))}
      </div>
    </div>
  );
}

const CHEV =
  "flex size-7 items-center justify-center rounded-md text-[var(--sd-quiet)] transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Stepper({
  name,
  values,
  value,
  onStep,
}: {
  name: string;
  values: string[];
  value: string;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        className={CHEV}
        aria-label={`Increase ${name}`}
        onClick={() => onStep(1)}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <DigitColumn values={values} value={value} />
      <button
        type="button"
        className={CHEV}
        aria-label={`Decrease ${name}`}
        onClick={() => onStep(-1)}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}

// 12-hour clock order: 12, 01, 02 … 11 (noon/midnight read as "12").
const HOURS = [
  "12",
  ...Array.from({ length: 11 }, (_, i) => String(i + 1).padStart(2, "0")),
];
const MINUTES = Array.from({ length: 12 }, (_, i) =>
  String(i * 5).padStart(2, "0"),
);
const MERIDIEMS = ["AM", "PM"];

/**
 * Themed time picker matching the DatePicker `field` trigger. Opens a popover
 * with two odometer-roll columns (12-hour hours, minutes) plus an AM/PM toggle.
 * Minutes step by 5 and carry into the hour; hours roll through the 12-hour
 * clock and flip AM/PM at the noon/midnight boundary. The value stays a 24-hour
 * ``HH:mm`` string; only the display is 12-hour.
 */
export function TimePicker({
  value,
  onChange,
  label,
  className,
  disabled,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const time = value || "06:00";
  const { hour12, minute, meridiem } = to12h(time);

  // Hours/minutes step on the 24-hour value so the carry (and the AM/PM flip at
  // noon/midnight) falls out for free; only the labels are 12-hour.
  const step = (field: "hour" | "minute", dir: 1 | -1) =>
    onChange(stepTime(time, field, dir));
  const setMeridiem = (mer: "AM" | "PM") =>
    onChange(from12h(Number(hour12), Number(minute), mer));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(FIELD_TRIGGER, className)}
          aria-label={label}
        >
          <ClockIcon className="h-3.5 w-3.5" />
          {format12h(time)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="flex items-center gap-2">
          <Stepper
            name="hour"
            values={HOURS}
            value={hour12}
            onStep={(dir) => step("hour", dir)}
          />
          <span className="pb-1 text-lg font-semibold text-muted-foreground">
            :
          </span>
          <Stepper
            name="minute"
            values={MINUTES}
            value={minute}
            onStep={(dir) => step("minute", dir)}
          />
          <Stepper
            name="AM/PM"
            values={MERIDIEMS}
            value={meridiem}
            onStep={() => setMeridiem(meridiem === "AM" ? "PM" : "AM")}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
