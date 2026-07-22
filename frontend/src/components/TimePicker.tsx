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
import { cn, stepTime } from "@/lib/utils";

export interface TimePickerProps {
  value: string; // HH:mm
  onChange: (next: string) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
}

/** Height (px) of a single odometer cell. Fixed px — not rem — so the roll
 *  translate stays exact regardless of the app's 85% root font-size. */
const CELL = 34;

/** Same pill idiom as DatePicker so date + time read as one control family. */
const PILL =
  "h-9 gap-2 rounded-full border-transparent bg-card px-4 text-xs font-medium tabular-nums text-foreground shadow-[var(--sd-shadow-1)] hover:bg-card hover:text-foreground hover:shadow-[var(--sd-shadow-2)] [&>svg]:text-[var(--sd-quiet)]";

/**
 * A single odometer column. Renders every value in `values` stacked vertically
 * and slides the strip so the selected value sits centered in a 3-row window,
 * with faded neighbors above/below. Single-step changes animate; a wrap jump
 * (e.g. 23 -> 00) snaps instantly instead of sliding the long way. Respects
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
  field,
  values,
  value,
  onStep,
}: {
  field: "hour" | "minute";
  values: string[];
  value: string;
  onStep: (field: "hour" | "minute", dir: 1 | -1) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        className={CHEV}
        aria-label={`Increase ${field}`}
        onClick={() => onStep(field, 1)}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <DigitColumn values={values} value={value} />
      <button
        type="button"
        className={CHEV}
        aria-label={`Decrease ${field}`}
        onClick={() => onStep(field, -1)}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) =>
  String(i * 5).padStart(2, "0"),
);

/**
 * Themed time picker matching DatePicker's pill trigger. Opens a popover with
 * two odometer-roll columns (hours, minutes) driven by up/down chevrons.
 * Minutes step by 5 and carry into the hour; hours wrap 23 <-> 00. Value is a
 * plain ``HH:mm`` string.
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
  const [hh, mm] = time.split(":");
  const step = (field: "hour" | "minute", dir: 1 | -1) =>
    onChange(stepTime(time, field, dir));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn(PILL, className)}
          aria-label={label}
        >
          <ClockIcon className="h-3.5 w-3.5" />
          {time}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <div className="flex items-center gap-2">
          <Stepper field="hour" values={HOURS} value={hh} onStep={step} />
          <span className="pb-1 text-lg font-semibold text-muted-foreground">
            :
          </span>
          <Stepper field="minute" values={MINUTES} value={mm} onStep={step} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
