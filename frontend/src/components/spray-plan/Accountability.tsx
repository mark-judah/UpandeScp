/**
 * Who was meant to run a spray and who did: the plan's team supervisor(s) and
 * whoever scanned a chemical at the CSU or started spraying, or "nobody
 * scanned". Shown on unfinished and missed sprays so a gap names the person
 * assigned AND the person who acted.
 */
import { cn } from "@/lib/utils";
import type { PlanAccountability } from "@/lib/lifecycle-api";

export function accountabilityText(a: PlanAccountability | null | undefined) {
  if (!a) return { supervisor: "", scanned: "" };
  return {
    supervisor: a.supervisors.length
      ? a.supervisors.map((s) => s.name).join(", ")
      : "no supervisor on the team",
    scanned: a.nobody_scanned ? "nobody scanned" : a.scanners.map((s) => s.name).join(", "),
  };
}

export function Accountability({
  value,
  className,
}: {
  value: PlanAccountability | null | undefined;
  className?: string;
}) {
  if (!value) return null;
  const t = accountabilityText(value);
  return (
    <div
      className={cn("text-[0.7rem] text-muted-foreground leading-snug", className)}
      data-testid="plan-accountability"
    >
      <span>Supervisor </span>
      <span className="font-medium text-foreground">{t.supervisor}</span>
      <span> · {value.nobody_scanned ? "" : "scanned by "}</span>
      <span
        className={cn("font-medium", value.nobody_scanned ? "text-[var(--sd-data-red)]" : "text-foreground")}
      >
        {t.scanned}
      </span>
    </div>
  );
}
