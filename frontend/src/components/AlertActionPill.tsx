import { ACTION_TONE, type AlertAction } from "@/lib/scouting-alerts-api";

/** Alarming / Spray advised / Scout first as a tinted pill (no border strip). */
export function AlertActionPill({ action }: { action: AlertAction }) {
  const tone = ACTION_TONE[action] ?? "var(--sd-muted)";
  return (
    <span
      data-testid="alert-action"
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none whitespace-nowrap"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {action}
    </span>
  );
}
