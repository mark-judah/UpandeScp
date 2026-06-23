import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";
import "react-day-picker/dist/style.css";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * Canonical shadcn calendar adapted for react-day-picker v9.
 *
 * v9 dropped the ``day_*`` prefix on most classNames (now ``selected``,
 * ``today``, ``outside``, …) and replaced the ``IconLeft``/``IconRight``
 * component overrides with a single ``Chevron`` slot that takes an
 * ``orientation`` prop. We keep the ISO-week column on the left side so
 * scouting users can pick by W-number.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  const defaults = getDefaultClassNames();
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      showWeekNumber
      ISOWeek
      weekStartsOn={1}
      className={cn("p-3", className)}
      classNames={{
        ...defaults,
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "w-full space-y-4",
        month_caption:
          "flex h-7 items-center justify-center px-10 text-sm font-medium",
        caption_label: "text-sm font-medium",
        nav: "absolute inset-x-1 top-1 flex items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "size-7 bg-transparent p-0 text-muted-foreground hover:text-foreground",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon" }),
          "size-7 bg-transparent p-0 text-muted-foreground hover:text-foreground",
        ),
        month_grid: "w-full border-collapse",
        weekdays: "flex w-full",
        weekday:
          "text-muted-foreground w-8 font-normal text-[0.7rem] uppercase tracking-wider",
        week: "flex w-full mt-1",
        week_number_header:
          "w-7 text-[0.65rem] font-medium uppercase tracking-wider text-muted-foreground/60",
        week_number:
          "w-7 text-[0.65rem] tabular-nums text-muted-foreground/60 font-medium flex items-center justify-center",
        day: "size-8 text-center text-sm p-0 relative focus-within:relative focus-within:z-20",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-8 p-0 font-normal aria-selected:opacity-100",
        ),
        range_start: "rounded-l-md bg-primary text-primary-foreground",
        range_end: "rounded-r-md bg-primary text-primary-foreground",
        range_middle: "bg-accent text-accent-foreground",
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent text-accent-foreground rounded-md",
        outside: "text-muted-foreground/40",
        disabled: "text-muted-foreground/40 cursor-not-allowed",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}
