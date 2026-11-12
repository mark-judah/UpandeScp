import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Smartphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  batteryPct, compareVersions, formatBytes, isLowBattery, isLowStorage, type ItDevice,
} from "@/lib/it-monitor-api";

/** Load on mount and whenever `key` changes; a refresh keeps the old data on screen. */
export function useLoad<T>(fn: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    fnRef
      .current()
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(run, [key]);
  return { data, loading, error, reload: run };
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {error}</div> : null;
}

export function NoDevicesYet() {
  return (
    <div className="rounded-xl border border-dashed bg-card px-6 py-10 text-center">
      <Smartphone className="mx-auto mb-3 h-8 w-8 text-muted-foreground" aria-hidden />
      <h3 className="text-sm font-semibold">No phones are reporting yet</h3>
      <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
        A phone appears here once it runs the Scout app update that includes device reporting, and its user opens
        the app while online. Until then nothing is collected: version, battery, storage and stuck data are all
        reported by the phone itself. Ask the field teams to update the app from the store.
      </p>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed bg-card px-4 py-8 text-center text-xs text-muted-foreground">{children}</div>;
}

export function SectionCard({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("min-w-0 rounded-xl bg-card p-4 shadow-[var(--sd-shadow-1)]", className)}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint ? <p className="mb-2 text-xs text-muted-foreground">{hint}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

/** App version, with a "behind" pill when it trails the latest. */
export function VersionBadge({ version, latest }: { version: string | null; latest: string | null }) {
  if (!version) return <span className="text-muted-foreground">unknown</span>;
  const behind = !!latest && compareVersions(version, latest) < 0;
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      {version}
      {behind ? (
        <Badge variant="outline" className="border-[var(--sd-data-amber)] px-1.5 py-0 text-[10px] text-[var(--sd-data-amber)]">
          behind
        </Badge>
      ) : null}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  Current: "text-[var(--sd-data-green)] border-[var(--sd-data-green)]",
  Behind: "text-[var(--sd-data-amber)] border-[var(--sd-data-amber)]",
  Dormant: "text-[var(--sd-data-red)] border-[var(--sd-data-red)]",
  Unknown: "text-muted-foreground border-border",
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("px-2 py-0 text-[11px]", STATUS_TONE[status] ?? STATUS_TONE.Unknown)}>
      {status}
    </Badge>
  );
}

export function BatteryCell({ d }: { d: ItDevice }) {
  const pct = batteryPct(d.battery_level);
  if (pct === null) return <span className="text-muted-foreground">-</span>;
  return (
    <span className={cn("tabular-nums", isLowBattery(d) && "font-medium text-[var(--sd-data-red)]")}>
      {pct}%{d.battery_state === "charging" ? " +" : ""}
    </span>
  );
}

export function StorageCell({ d }: { d: ItDevice }) {
  if (d.storage_free_bytes === null) return <span className="text-muted-foreground">-</span>;
  return (
    <span className={cn("tabular-nums", isLowStorage(d) && "font-medium text-[var(--sd-data-red)]")}>
      {formatBytes(d.storage_free_bytes)}
    </span>
  );
}

export function PendingCell({ d }: { d: ItDevice }) {
  return (
    <span className="tabular-nums">
      {d.pending_total}
      {d.stuck_total > 0 ? <span className="ml-1 font-medium text-[var(--sd-data-red)]">/ {d.stuck_total} stuck</span> : null}
    </span>
  );
}

export const CHART_COLORS = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)",
  "var(--chart-5)", "var(--chart-6)", "var(--chart-7)", "var(--muted-foreground)", "var(--sd-quiet)",
];
