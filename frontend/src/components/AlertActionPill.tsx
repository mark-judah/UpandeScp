import { ACTION_TONE, LEVEL_TONE, type AlertAction } from "@/lib/scouting-alerts-api";

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

/** Which level of a block crop an alert is: the block's per-hectare line, or a hot spot by tree. */
export function AlertLevelPill({ level }: { level: "Block" | "Hot spot" }) {
  const tone = LEVEL_TONE[level];
  return (
    <span
      data-testid="alert-level"
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none whitespace-nowrap"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {level === "Block" ? "Block, per ha" : "Hot spot, per tree"}
    </span>
  );
}
