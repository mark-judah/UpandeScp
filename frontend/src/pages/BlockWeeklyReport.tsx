import { useEffect, useState } from "react";
import { Download, Loader2, AlertCircle, Layers } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/PageHeader";
import { call } from "@/lib/frappe";

const NS = "upande_scp.serverscripts.reports.block_weekly_report";

interface ReadyFarm {
  farm: string;
  blocks: number;
}
interface BlockedFarm {
  farm: string;
  reason: string;
}
interface Availability {
  crop: string;
  ready: ReadyFarm[];
  blocked: BlockedFarm[];
}
interface WeekOption {
  year: number;
  week: number;
  entries: number;
  label: string;
}

/**
 * The weekly pest sheet for block-grown crops — avocado and coffee.
 *
 * Roses submit the six-sheet KEPHIS FCM workbook, which is a regulated template for
 * false codling moth. These crops are not FCM-reportable and want something plainer:
 * one sheet, blocks down the rows, pests across the columns.
 *
 * The page's real job beyond the download is **saying why a report is missing**. Coffee
 * is grown on Endebess and Saboti, and neither has a warehouse typed as a block, so a
 * download would produce a sheet whose blankness means "nothing is set up" while
 * looking exactly like "a clean week". A farm in that state is listed with its reason
 * and cannot be selected.
 */
export function BlockWeeklyReport({ crop }: { crop: string }) {
  const [avail, setAvail] = useState<Availability | null>(null);
  const [farm, setFarm] = useState<string>("");
  const [weeks, setWeeks] = useState<WeekOption[]>([]);
  const [week, setWeek] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    call<Availability>(`${NS}.availability`, { crop })
      .then((r) => {
        setAvail(r);
        if (r?.ready?.length) setFarm(r.ready[0].farm);
      })
      .catch(() => setAvail({ crop, ready: [], blocked: [] }))
      .finally(() => setLoading(false));
  }, [crop]);

  useEffect(() => {
    if (!farm) {
      setWeeks([]);
      setWeek("");
      return;
    }
    call<WeekOption[]>(`${NS}.report_weeks`, { crop, farm })
      .then((r) => {
        const arr = Array.isArray(r) ? r : [];
        setWeeks(arr);
        setWeek(arr.length ? `${arr[0].year}-${arr[0].week}` : "");
      })
      .catch(() => setWeeks([]));
  }, [crop, farm]);

  const download = () => {
    const [year, wk] = week.split("-");
    window.location.href =
      `/api/method/${NS}.download_block_weekly_xlsx` +
      `?crop=${encodeURIComponent(crop)}&farm=${encodeURIComponent(farm)}` +
      `&year=${encodeURIComponent(year)}&week=${encodeURIComponent(wk)}`;
  };

  const ready = avail?.ready ?? [];
  const blocked = avail?.blocked ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description={`Weekly pest counts per block for ${crop}.`}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" /> Weekly Block Report
          </CardTitle>
          <CardDescription>
            One sheet: every block on the farm down the rows, every pest across the
            columns, and the week&rsquo;s total counts in the cells. A block that was
            walked and found clean shows zeros rather than disappearing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking which farms have
              blocks&hellip;
            </div>
          ) : ready.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No farm growing {crop} has blocks set up yet, so there is nothing to
              report on.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label>Farm</Label>
                <Select value={farm} onValueChange={setFarm}>
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Pick a farm" />
                  </SelectTrigger>
                  <SelectContent>
                    {ready.map((f) => (
                      <SelectItem key={f.farm} value={f.farm}>
                        {f.farm} ({f.blocks} blocks)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label>Week</Label>
                <Select value={week} onValueChange={setWeek}>
                  <SelectTrigger className="w-72">
                    <SelectValue
                      placeholder={
                        weeks.length ? "Pick a week" : "No scouting on this farm yet"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {weeks.map((w) => (
                      <SelectItem key={`${w.year}-${w.week}`} value={`${w.year}-${w.week}`}>
                        {w.label} · {w.entries} entries
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button onClick={download} disabled={!farm || !week}>
                <Download className="mr-2 h-4 w-4" /> Download
              </Button>
            </div>
          )}

          {blocked.length > 0 && (
            <div className="rounded-md border border-amber-300/60 bg-amber-50/60 p-3 dark:border-amber-800/50 dark:bg-amber-950/30">
              <p className="mb-1 flex items-center gap-2 text-sm font-medium">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                Farms that cannot be reported on yet
              </p>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {blocked.map((b) => (
                  <li key={b.farm}>{b.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
