/**
 * "9/12 available" on a plan, opening the crew list on hover or click (spec C2):
 * each member's photo, name, role and a status pill for the plan's date.
 */
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CREW_STATUS_LABEL, type CrewStatus, type SchedulePlan } from "@/lib/schedule-api";
import { cn } from "@/lib/utils";
import { WARN_COLORS, paint, type ChipColors } from "./schedule-colors";

/** Pill colours per crew status — tint + dark same-hue text, both themes AA. */
export const STATUS_PILL: Record<CrewStatus, { light: ChipColors; dark: ChipColors }> = {
  ok: {
    light: { bg: "#dcfce7", fg: "#14532d", border: "#86efac" },
    dark: { bg: "#052e16", fg: "#bbf7d0", border: "#15803d" },
  },
  on_leave: WARN_COLORS,
  leave_pending: {
    light: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
    dark: { bg: "#451a03", fg: "#fde68a", border: "#92400e" },
  },
  not_checked_in: {
    light: { bg: "#f1f5f9", fg: "#1e293b", border: "#cbd5e1" },
    dark: { bg: "#0f172a", fg: "#e2e8f0", border: "#475569" },
  },
};

export function crewCounts(p: Pick<SchedulePlan, "crewAvailability">) {
  const crew = p.crewAvailability || [];
  const available = crew.filter((m) => m.status === "ok").length;
  return { available, total: crew.length, unavailable: crew.length - available };
}

export function hasUnavailable(p: Pick<SchedulePlan, "crewAvailability">): boolean {
  return crewCounts(p).unavailable > 0;
}

export function CrewPopover({
  plan,
  compact = false,
  onOpenPlan,
}: {
  plan: SchedulePlan;
  /** "9/12" only — for narrow Gantt bars; the full phrase is the accessible name */
  compact?: boolean;
  onOpenPlan?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hover opens it for a look; a click pins it open (or closes a pinned one).
  const pinned = useRef(false);
  const { available, total, unavailable } = crewCounts(plan);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  if (total === 0) return null;

  const hoverIn = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hoverOut = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (pinned.current) return;
    closeTimer.current = setTimeout(() => setOpen(false), 150);
  };
  const change = (next: boolean) => {
    if (!next) pinned.current = false;
    setOpen(next);
  };
  const tone = unavailable > 0 ? paint(STATUS_PILL.on_leave) : paint(STATUS_PILL.ok);
  const phrase = `${available}/${total} available`;

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="crew-count"
          aria-label={`${available} of ${total} crew available`}
          title={phrase}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
          onClick={(e) => {
            // Radix would toggle; a hover-opened popover must stay open on click.
            e.preventDefault();
            e.stopPropagation();
            if (closeTimer.current) clearTimeout(closeTimer.current);
            const close = open && pinned.current;
            pinned.current = !close;
            setOpen(!close);
          }}
          className={cn(
            "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[0.6rem] font-semibold leading-4 tabular-nums",
            tone.className,
          )}
          style={tone.style}
        >
          {!compact && <Users className="h-2.5 w-2.5" aria-hidden />}
          {compact ? `${available}/${total}` : phrase}
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="crew-popover"
        className="w-80 p-2"
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
      >
        <div className="mb-1.5 flex items-baseline justify-between gap-2 px-1">
          <span className="truncate text-xs font-semibold">
            Crew · {plan.start ?? ""}
          </span>
          <span className="shrink-0 text-[0.68rem] text-muted-foreground">{phrase}</span>
        </div>
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {(plan.crewAvailability || []).map((m) => {
            const pill = paint(STATUS_PILL[m.status] || STATUS_PILL.ok);
            return (
              <li key={m.employee} data-testid="crew-member" data-status={m.status} className="flex items-center gap-2 rounded-lg px-1 py-1">
                <PersonAvatar id={m.employee} name={m.name} image={m.image} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{m.name}</span>
                  <span className="block truncate text-[0.65rem] text-muted-foreground">{m.role || "Crew"}</span>
                </span>
                <span
                  className={cn("shrink-0 rounded-full px-2 py-0.5 text-[0.62rem] font-semibold", pill.className)}
                  style={pill.style}
                >
                  {CREW_STATUS_LABEL[m.status] || m.status}
                </span>
              </li>
            );
          })}
        </ul>
        {onOpenPlan && (
          <button
            type="button"
            onClick={onOpenPlan}
            className="mt-1.5 w-full rounded-md px-2 py-1 text-left text-[0.7rem] font-medium text-primary hover:bg-muted"
          >
            Open {plan.name}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
