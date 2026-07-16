import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared header control styling so every page's header reads identically to
 * the dashboard's: pill-shaped dropdowns and circular icon-only buttons.
 *
 * `HEADER_PILL` is the trigger className for header dropdowns (Select or
 * Popover triggers). `HeaderIconButton` is the circular icon button used for
 * refresh / thresholds / any single-glyph header action.
 */
export const HEADER_PILL =
  "h-9 w-auto min-w-[7rem] gap-2 rounded-full border-transparent bg-card px-4 text-xs font-medium shadow-[var(--sd-shadow-1)] hover:shadow-[var(--sd-shadow-2)] focus:ring-0";

export const HeaderIconButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { active?: boolean }
>(({ className, active, ...props }, ref) => (
  <Button
    ref={ref}
    type="button"
    variant="ghost"
    size="icon"
    aria-pressed={active}
    className={cn(
      "h-9 w-9 shrink-0 rounded-full bg-card text-[var(--sd-muted)] shadow-[var(--sd-shadow-1)] transition-all hover:-translate-y-px hover:text-foreground hover:shadow-[var(--sd-shadow-2)]",
      active &&
        "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
      className,
    )}
    {...props}
  />
));
HeaderIconButton.displayName = "HeaderIconButton";
