import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Kpi, KpiGrid } from "./Kpi";
import { EmptyHint } from "./EmptyHint";
import type {
  FlagKind,
  QualityFlag,
  QualityHouse,
  QualityPayload,
  QualityScout,
} from "./quality-types";

/** Pill text and colour per flag kind — the accent lives in the pill, never a strip. */
const KIND: Record<FlagKind, { label: string; color: string }> = {
  map_offset:    { label: "Map offset?",    color: "var(--sd-data-purple)" },
  not_scouted_recently: { label: "Not scouted recently", color: "var(--sd-data-pink)" },
  thin_coverage: { label: "Thin coverage",  color: "var(--sd-target)" },
  metadata_gap:  { label: "No GPS detail",  color: "var(--sd-quiet)" },
  too_fast:      { label: "Too fast",       color: "var(--sd-data-red)" },
  nothing_found: { label: "Nothing found",  color: "var(--sd-data-amber)" },
  off_zone:      { label: "Off zone",       color: "var(--sd-data-indigo)" },
  duplicates:    { label: "Duplicates",     color: "var(--sd-data-cyan)" },
};

const NO_GPS = "no GPS detail";

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${v}%`;
}

function num(v: number | null | undefined, unit = ""): string {
  return v == null ? "—" : `${v.toLocaleString("en-US")}${unit}`;
}

function syncText(min: number | null): string {
  if (min == null) return "—";
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
}

function Pill({ kind }: { kind: FlagKind }) {
  const k = KIND[kind];
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none"
      style={{ color: k.color, background: `color-mix(in srgb, ${k.color} 14%, transparent)` }}
    >
      {k.label}
    </span>
  );
}

// ── sortable table ───────────────────────────────────────────────────────

type SortState<K> = { key: K; desc: boolean };

function useSorted<T, K extends keyof T>(rows: T[], initial: K) {
  const [sort, setSort] = useState<SortState<K>>({ key: initial, desc: true });
  const sorted = useMemo(() => {
    const out = rows.slice();
    out.sort((a, b) => {
      const x = a[sort.key] as unknown;
      const y = b[sort.key] as unknown;
      // Blanks always last, whatever the direction.
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, sort]);
  const toggle = (key: K) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: true }));
  return { sorted, sort, toggle };
}

function SortHead<K>({
  label,
  col,
  sort,
  onSort,
  right = true,
  title,
}: {
  label: string;
  col: K;
  sort: SortState<K>;
  onSort: (k: K) => void;
  right?: boolean;
  title?: string;
}) {
  const active = sort.key === col;
  return (
    <TableHead className={right ? "text-right" : undefined} title={title}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground",
          active && "text-foreground",
        )}
      >
        {label}
        {active && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </TableHead>
  );
}

// ── sections ─────────────────────────────────────────────────────────────

function FlagList({ flags }: { flags: QualityFlag[] }) {
  if (!flags.length) {
    return (
      <EmptyHint
        title="Nothing needs attention"
        hint="No house or scout crosses a data-quality line in this range."
      />
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-[var(--sd-line)]">
      {flags.map((f) => (
        <li
          key={`${f.kind}:${f.name}`}
          data-testid="quality-flag"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
        >
          <Pill kind={f.kind} />
          <span className="font-medium text-foreground">{f.label}</span>
          <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--sd-quiet)]">
            {f.subject}
          </span>
          <span className="min-w-0 flex-1 basis-full text-[13px] text-muted-foreground sm:basis-auto">
            {f.detail}
          </span>
          <span className="tabular-nums text-sm text-foreground">
            {f.value}
            {f.unit === "m" ? " m" : f.unit}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A GPS figure: the value, greyed when the house's metadata is thin, or "no GPS detail". */
function GpsCell({ value, thin, none }: { value: string; thin: boolean; none: boolean }) {
  return (
    <TableCell
      className={cn("text-right tabular-nums", thin && "text-[var(--sd-quiet)] opacity-60")}
      title={thin ? "Fewer than half of the entries carry GPS detail — figure incomplete" : undefined}
    >
      {none ? <span className="text-xs italic">{NO_GPS}</span> : value}
    </TableCell>
  );
}

function HouseTable({ rows }: { rows: QualityHouse[] }) {
  const { sorted, sort, toggle } = useSorted<QualityHouse, keyof QualityHouse>(rows, "entries");
  const anyThin = rows.some((r) => !r.gpsReliable);
  const head = (label: string, col: keyof QualityHouse, title?: string, right = true) => (
    <SortHead label={label} col={col} sort={sort} onSort={toggle} right={right} title={title} />
  );
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2">
        <CardTitle>Houses</CardTitle>
        <CardDescription>
          Coverage is the house's latest complete week in the range (the current week only when
          nothing else is, marked partial); GPS figures cover every entry.
          {anyThin && (
            <span className="mt-1 block">
              Greyed GPS figures: fewer than half of that house's entries carry GPS detail
              (weeks synced before the metadata pull have none).
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {head("House", "house", undefined, false)}
                {head("Coverage", "coveragePct", "Stations scouted ÷ stations, latest week")}
                {head("Sections", "sectionsScouted", "Sections of 9 with enough stations scouted")}
                {head("Entries", "entries")}
                {head("Scouts", "scouts")}
                {head("GPS detail", "metadataPct", "Entries with a Scouting Entry Metadata row")}
                {head("Off zone", "offZonePct", "Fixes farther from their zone than its buffer")}
                {head("Median", "medianDistance", "Median fix-to-zone distance")}
                {head("P90", "p90Distance", "90th percentile fix-to-zone distance")}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((h) => {
                const thin = !h.gpsReliable;
                const none = !h.fixes;
                return (
                  <TableRow key={h.house} data-testid="quality-house" data-gps={thin ? "thin" : "ok"}>
                    <TableCell className="font-medium whitespace-nowrap">{h.house}</TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {h.weekPartial && h.coveragePct != null && (
                        <span className="mr-1 text-[11px] text-[var(--sd-quiet)]">partial week</span>
                      )}
                      {pct(h.coveragePct)}
                      {h.stations ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {num(h.stationsScouted)}/{num(h.stations)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {h.sectionsScouted == null ? "—" : `${h.sectionsScouted}/9`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{num(h.entries)}</TableCell>
                    <TableCell className="text-right tabular-nums">{h.scouts}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", thin && "text-[var(--sd-quiet)]")}>
                      {pct(h.metadataPct)}
                    </TableCell>
                    <GpsCell value={pct(h.offZonePct)} thin={thin} none={none} />
                    <GpsCell value={num(h.medianDistance, " m")} thin={thin} none={none} />
                    <GpsCell value={num(h.p90Distance, " m")} thin={thin} none={none} />
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyHint />
        )}
      </CardContent>
    </Card>
  );
}

function ScoutTable({
  rows,
  scopeNothing,
  metadataMinPct,
}: {
  rows: QualityScout[];
  scopeNothing: number | null;
  metadataMinPct: number;
}) {
  const { sorted, sort, toggle } = useSorted<QualityScout, keyof QualityScout>(rows, "entries");
  const head = (label: string, col: keyof QualityScout, title?: string, right = true) => (
    <SortHead label={label} col={col} sort={sort} onSort={toggle} right={right} title={title} />
  );
  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-2">
        <CardTitle>Scouts</CardTitle>
        <CardDescription>
          Nothing found is compared with the scope's {pct(scopeNothing)}; off zone with the houses
          the scout worked. Sync is informational: entry creation minus capture time, for entries
          created after the bulk load.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {rows.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {head("Scout", "scoutName", undefined, false)}
                {head("Entries", "entries")}
                {head("Days", "activeDays")}
                {head("Per hour", "entriesPerHour", "Entries per active hour (first → last capture each day)")}
                {head("Beds / day", "bedsPerDay")}
                {head("Too fast", "tooFastPct", "Zone-to-zone moves under 5 s")}
                {head("Nothing found", "nothingFoundPct", "Entries with no pest or disease row")}
                {head("Off zone", "offZonePct", "Fixes farther from their zone than its buffer")}
                {head("Duplicates", "duplicatePct", "Double-submits: same station, same second")}
                {head("Sync", "medianSyncMin", "Median of entry creation minus capture time (informational)")}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((s) => {
                const thin = (s.metadataPct ?? 0) < metadataMinPct;
                return (
                  <TableRow key={s.scout} data-testid="quality-scout" data-scout={s.scout}>
                    <TableCell className="font-medium whitespace-nowrap">{s.scoutName}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(s.entries)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.activeDays}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(s.entriesPerHour)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(s.bedsPerDay)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(s.tooFastPct)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(s.nothingFoundPct)}</TableCell>
                    <GpsCell
                      value={
                        s.houseOffZonePct == null
                          ? pct(s.offZonePct)
                          : `${pct(s.offZonePct)} vs ${pct(s.houseOffZonePct)}`
                      }
                      thin={thin}
                      none={!s.fixes}
                    />
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {pct(s.duplicatePct)}
                      {s.duplicates ? (
                        <span className="ml-1 text-xs text-muted-foreground">{num(s.duplicates)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {syncText(s.medianSyncMin)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyHint />
        )}
      </CardContent>
    </Card>
  );
}

// ── tab ──────────────────────────────────────────────────────────────────

export function DataQualityTab({ data }: { data: QualityPayload | null }) {
  // Nothing fetched yet (or the fetch failed — Dashboard shows the error): no
  // "Nothing needs attention", no empty tables, just a quiet placeholder.
  if (!data) {
    return (
      <div data-testid="quality-loading" className="flex flex-col gap-4">
        <KpiGrid cols={4}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[132px] rounded-xl" />
          ))}
        </KpiGrid>
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  const k = data.kpis;
  const t = data.thresholds;
  const gpsThin = k.metadataPct != null && k.metadataPct < t.metadataMinPct;
  const over = (v: number | null | undefined, line: number | undefined) =>
    v != null && line != null && v > line ? "warning" : "default";

  return (
    <div className="flex flex-col gap-4">
      {data.clamped && (
        <div data-testid="quality-clamped" className="text-[13px] text-[var(--sd-quiet)]">
          Range capped at {data.thresholds.maxRangeDays / 7} weeks: showing {data.range.from_date} to{" "}
          {data.range.to_date}.
        </div>
      )}
      <KpiGrid cols={4}>
        <Kpi
          label="Station coverage"
          value={pct(k.coveragePct)}
          hint="stations scouted · each house's latest week"
          tone={
            k.coveragePct != null && k.coveragePct < t.thinCoveragePct ? "warning" : "default"
          }
        />
        <Kpi
          label="Off-zone fixes"
          value={pct(k.offZonePct)}
          hint={
            gpsThin
              ? `GPS detail on only ${pct(k.metadataPct)} of entries`
              : k.zoneMapSuspect
                ? "fixes outside their zone — zone map needs checking"
                : "fixes outside their zone"
          }
          tone={k.zoneMapSuspect ? "warning" : "default"}
          className={gpsThin ? "opacity-60" : undefined}
        />
        <Kpi
          label="Too fast"
          value={pct(k.tooFastPct)}
          hint={`zone-to-zone moves under ${t.tooFastSeconds} s`}
          tone={over(k.tooFastPct, t.tooFastPct)}
        />
        <Kpi
          label="GPS detail"
          value={pct(k.metadataPct)}
          hint={`of ${num(k.entries)} entries carry metadata`}
          tone={gpsThin ? "warning" : "default"}
        />
      </KpiGrid>

      <Card className="p-4">
        <CardHeader className="p-0 pb-2">
          <CardTitle>Needs attention</CardTitle>
          <CardDescription>
            Houses and scouts past a data-quality line, furthest past first.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <FlagList flags={data.flags} />
        </CardContent>
      </Card>

      <HouseTable rows={data.houses} />
      <ScoutTable
        rows={data.scouts}
        scopeNothing={k.nothingFoundPct}
        metadataMinPct={data.thresholds.metadataMinPct}
      />
    </div>
  );
}
