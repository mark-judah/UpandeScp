/**
 * Date + time pickers for a spray plan's schedule that cannot go earlier than now:
 * past days are disabled, and for today the time is held at the next free slot.
 */
import { useEffect } from "react";
import { DatePicker } from "@/components/DatePicker";
import { TimePicker } from "@/components/TimePicker";
import { clampNotPast } from "@/lib/schedule";
import { usePlanningWindow } from "@/lib/planning-window-api";
import { mergeDateTime, splitDateTime, ymd } from "@/lib/utils";

export function SprayWhenPicker({
  value,
  onChange,
}: {
  /** "YYYY-MM-DD HH:mm:00" */
  value: string;
  onChange: (next: string) => void;
}) {
  // A default or restored value that has since slipped into the past is pulled up.
  useEffect(() => {
    const next = clampNotPast(value);
    if (next !== value) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const { days, maxDate } = usePlanningWindow();
  const { date, time } = splitDateTime(value);
  return (
    <>
      <DatePicker
        variant="field"
        value={date}
        minDate={ymd(new Date())}
        maxDate={maxDate}
        onChange={(d) => onChange(clampNotPast(mergeDateTime(d, time)))}
      />
      <TimePicker
        value={time}
        onChange={(t) => onChange(clampNotPast(mergeDateTime(date, t)))}
      />
      <p className="basis-full text-[0.65rem] text-muted-foreground leading-snug">
        Plans can be made up to {days} days ahead; chemicals are held for {days} days.
      </p>
    </>
  );
}
