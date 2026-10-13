/**
 * Crop Protection ▸ Re-entry — which houses may be entered or harvested right now.
 *
 * Three lists per the farm/house picked: houses with NO ENTRY (a countdown to the
 * re-entry time), houses whose HARVEST is held (until the pre-harvest interval
 * ends), and houses CLEARED in the last 24 h. Production reads this instead of
 * asking the sprayers. The clocks start when the spray actually ended.
 *
 * Server: serverscripts/spray_plan_creator/reentry.py (get_entry_board). Redraws
 * every minute; the countdown ticks against the server's clock.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { PlacePicker } from "@/components/PlacePicker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableRowsSkeleton } from "@/components/Loading";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import {
  fetchEntryBoard,
  formatRemaining,
  parseServerTime,
  type EntryBoard,
  type HouseEntry,
} from "@/lib/reentry-api";
import type { Place } from "@/lib/places";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;
const CLEARED_WINDOW_MS = 24 * 3600 * 1000;

const PILL = {
  no_entry: "border-transparent bg-red-100 text-red-800",
  harvest_held: "border-transparent bg-amber-100 text-amber-800",
  clear: "border-transparent bg-emerald-100 text-emerald-800",
} as const;

function clock(d: Date | null): string {
  return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
}

/** "14:30" for today, "Thu 15 Oct 14:30" otherwise, against the server's now. */
function when(d: Date | null, now: number): string {
  if (!d) return "—";
  if (new Date(now).toDateString() === d.toDateString()) return clock(d);
  return `${d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short" })} ${clock(d)}`;
}

function Products({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-muted-foreground">—</span>;
  return <span className="text-xs text-muted-foreground">{items.join(", ")}</span>;
}

function Section({
  title,
  description,
  pill,
  count,
  columns,
  pending,
  empty,
  children,
  testId,
}: {
  title: string;
  description: string;
  pill: keyof typeof PILL;
  count: number;
  columns: string[];
  pending: boolean;
  empty: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId} aria-busy={pending || undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {title}
          {!pending && <Badge className={cn("tabular-nums", PILL[pill])}>{count}</Badge>}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Table aria-label={title}>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pending ? (
              <TableRowsSkeleton cols={columns.length} rows={3} />
            ) : count === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-6 text-center text-sm text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              children
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function Reentry({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const { farms, loading: farmsLoading } = useCropFarms(crop);
  const [place, setPlace] = useState<Place>({ farm: "", greenhouse: "" });
  const [board, setBoard] = useState<EntryBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  // server clock minus browser clock at the last fetch, plus a tick for the countdown
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    let alive = true;
    fetchEntryBoard(crop)
      .then((b) => {
        if (!alive) return;
        const server = parseServerTime(b.now);
        setSkew(server ? server.getTime() - Date.now() : 0);
        setBoard(b);
        setError(null);
      })
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [crop]);

  useEffect(() => {
    setBoard(null);
    const cancel = load();
    const id = window.setInterval(load, REFRESH_MS);
    const clockId = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => {
      cancel();
      window.clearInterval(id);
      window.clearInterval(clockId);
    };
  }, [load]);

  void tick;
  const now = Date.now() + skew; // `tick` only forces the re-render that moves the countdown
  const pending = !board && !error;

  const visible = useMemo(() => {
    const all = board?.houses ?? [];
    return all.filter((h) =>
      place.greenhouse ? h.house === place.greenhouse : place.farm ? h.farm === place.farm : true,
    );
  }, [board, place]);

  const noEntry = visible.filter((h) => h.status === "no_entry");
  const held = visible.filter((h) => h.status === "harvest_held");
  const cleared = visible.filter((h) => {
    if (h.status !== "clear") return false;
    const at = parseServerTime(h.cleared_at);
    return !!at && now - at.getTime() <= CLEARED_WINDOW_MS;
  });

  const label = (h: HouseEntry) => (
    <div className="flex flex-col">
      <span className="font-medium">{h.house_label || h.house}</span>
      <span className="text-xs text-muted-foreground">{h.farm}</span>
    </div>
  );

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Crop Protection · Spray safety" title="Re-entry">
        <PlacePicker
          farms={farms}
          crop={crop}
          label="Re-entry farm and house"
          value={place}
          onChange={setPlace}
          disabled={farmsLoading}
        />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        {error && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base text-destructive">Could not load the board</CardTitle>
              <CardDescription>{error}</CardDescription>
            </CardHeader>
          </Card>
        )}

        <Section
          testId="section-no-entry"
          title="No entry"
          description="Sprayed and still inside the re-entry interval. Nobody goes in until the time shown."
          pill="no_entry"
          count={noEntry.length}
          columns={["House", "Products", "Ended", "No entry until", "Time left"]}
          pending={pending}
          empty="No house is closed for re-entry."
        >
          {noEntry.map((h) => {
            const until = parseServerTime(h.reentry_time);
            return (
              <TableRow key={h.house} data-testid="no-entry-row">
                <TableCell>{label(h)}</TableCell>
                <TableCell><Products items={h.products} /></TableCell>
                <TableCell className="tabular-nums">{when(parseServerTime(h.ended_at), now)}</TableCell>
                <TableCell className="tabular-nums">{when(until, now)}</TableCell>
                <TableCell>
                  <Badge className={cn("tabular-nums", PILL.no_entry)}>
                    {until ? formatRemaining(until.getTime() - now) : "—"}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </Section>

        <Section
          testId="section-harvest-held"
          title="Harvest held"
          description="Safe to walk in, but the pre-harvest interval has not ended. Do not pick."
          pill="harvest_held"
          count={held.length}
          columns={["House", "Products", "Ended", "Harvest from", "Time left"]}
          pending={pending}
          empty="No house is held for harvest."
        >
          {held.map((h) => {
            const from = parseServerTime(h.harvest_after);
            return (
              <TableRow key={h.house} data-testid="held-row">
                <TableCell>{label(h)}</TableCell>
                <TableCell><Products items={h.products} /></TableCell>
                <TableCell className="tabular-nums">{when(parseServerTime(h.ended_at), now)}</TableCell>
                <TableCell className="tabular-nums">{when(from, now)}</TableCell>
                <TableCell>
                  <Badge className={cn("tabular-nums", PILL.harvest_held)}>
                    {from ? formatRemaining(from.getTime() - now) : "—"}
                  </Badge>
                </TableCell>
              </TableRow>
            );
          })}
        </Section>

        <Section
          testId="section-cleared"
          title="Cleared in the last 24 h"
          description="Became safe to enter and harvest within the last day."
          pill="clear"
          count={cleared.length}
          columns={["House", "Products", "Ended", "Cleared"]}
          pending={pending}
          empty="Nothing has cleared in the last 24 hours."
        >
          {cleared.map((h) => (
            <TableRow key={h.house} data-testid="cleared-row">
              <TableCell>{label(h)}</TableCell>
              <TableCell><Products items={h.products} /></TableCell>
              <TableCell className="tabular-nums">{when(parseServerTime(h.ended_at), now)}</TableCell>
              <TableCell className="tabular-nums">{when(parseServerTime(h.cleared_at), now)}</TableCell>
            </TableRow>
          ))}
        </Section>
      </div>
    </div>
  );
}
