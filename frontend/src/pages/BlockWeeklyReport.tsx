import { useEffect, useMemo, useRef, useState } from "react";
import { PlaceMultiPicker } from "@/components/PlaceMultiPicker";
import { EMPTY_PLACE_SET, encodeNames, isEmptyPlaceSet, type PlaceSet } from "@/lib/places";
import { Download, AlertCircle, Layers, Mail } from "lucide-react";
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
import { TextSkeleton } from "@/components/Loading";
import { call } from "@/lib/frappe";
import {
  previewCumulativeAlertEmail,
  previewWeeklyBlockEmail,
  sendTestCumulativeAlert,
  sendTestWeeklyBlockEmail,
} from "@/lib/cumulative-api";
import { errorText } from "@/lib/errors";

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
  // A workbook (and a weekly email) is one farm's, so several farms give one each.
  const [places, setPlaces] = useState<PlaceSet>(EMPTY_PLACE_SET);
  const picked = useRef(false);
  const [weeks, setWeeks] = useState<WeekOption[]>([]);
  const [week, setWeek] = useState<string>("");
  const readyNames = useMemo(() => (avail?.ready ?? []).map((f) => f.farm), [avail]);
  const selFarms = useMemo(
    () => (isEmptyPlaceSet(places) ? readyNames : readyNames.filter((f) => places.farms.includes(f))),
    [places, readyNames],
  );
  const farm = encodeNames(selFarms);
  const [loading, setLoading] = useState(true);
  const [weeksLoading, setWeeksLoading] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState<"preview" | "test" | null>(null);
  const [alertNote, setAlertNote] = useState<{ ok: boolean; text: string } | null>(null);

  const [wkHtml, setWkHtml] = useState<string | null>(null);
  const [wkBusy, setWkBusy] = useState<"preview" | "test" | null>(null);
  const [wkNote, setWkNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    call<Availability>(`${NS}.availability`, { crop })
      .then((r) => {
        setAvail(r);
        // Open on the first farm; Select all picks every one.
        if (r?.ready?.length && !picked.current) setPlaces({ farms: [r.ready[0].farm], greenhouses: [] });
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
    setWeeksLoading(true);
    call<WeekOption[]>(`${NS}.report_weeks`, { crop, farm })
      .then((r) => {
        const arr = Array.isArray(r) ? r : [];
        setWeeks(arr);
        setWeek(arr.length ? `${arr[0].year}-${arr[0].week}` : "");
      })
      .catch(() => setWeeks([]))
      .finally(() => setWeeksLoading(false));
  }, [crop, farm]);

  const download = () => {
    const [year, wk] = week.split("-");
    const url = (f: string) =>
      `/api/method/${NS}.download_block_weekly_xlsx` +
      `?crop=${encodeURIComponent(crop)}&farm=${encodeURIComponent(f)}` +
      `&year=${encodeURIComponent(year)}&week=${encodeURIComponent(wk)}`;
    if (selFarms.length === 1) {
      window.location.href = url(selFarms[0]);
      return;
    }
    // One workbook per farm: each through its own link, a moment apart.
    selFarms.forEach((f, i) =>
      window.setTimeout(() => {
        const a = document.createElement("a");
        a.href = url(f);
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 700),
    );
  };

  const previewWeekly = async () => {
    setWkBusy("preview");
    setWkNote(null);
    try {
      const parts: string[] = [];
      for (const f of selFarms.length ? selFarms : [undefined]) parts.push(await previewWeeklyBlockEmail(crop, f));
      setWkHtml(parts.join("<hr/>"));
    } catch (e) {
      setWkNote({ ok: false, text: errorText(e, "Could not build the preview.") });
    } finally {
      setWkBusy(null);
    }
  };
  const testWeekly = async () => {
    setWkBusy("test");
    setWkNote(null);
    try {
      const results: { f?: string; r: Awaited<ReturnType<typeof sendTestWeeklyBlockEmail>> }[] = [];
      for (const f of selFarms.length ? selFarms : [undefined]) {
        results.push({ f, r: await sendTestWeeklyBlockEmail(crop, f) });
      }
      const sent = results.filter((x) => x.r.sent);
      const failed = results.filter((x) => !x.r.sent);
      setWkNote(
        failed.length
          ? { ok: false, text: failed.map((x) => `${x.f ? x.f + ": " : ""}${x.r.reason || "Test email was not sent."}`).join(" ") }
          : { ok: true, text: `Test email sent to ${sent.map((x) => x.r.to).join(", ")}.` },
      );
    } catch (e) {
      setWkNote({ ok: false, text: errorText(e, "Test email failed.") });
    } finally {
      setWkBusy(null);
    }
  };

  const previewAlert = async () => {
    setAlertBusy("preview");
    setAlertNote(null);
    try {
      setPreviewHtml(await previewCumulativeAlertEmail(crop));
    } catch (e) {
      setAlertNote({ ok: false, text: errorText(e, "Could not build the preview.") });
    } finally {
      setAlertBusy(null);
    }
  };
  const testAlert = async () => {
    setAlertBusy("test");
    setAlertNote(null);
    try {
      const r = await sendTestCumulativeAlert(crop);
      setAlertNote(
        r.sent
          ? { ok: true, text: `Test email sent to ${r.to}.` }
          : { ok: false, text: r.reason || "Test email was not sent." },
      );
    } catch (e) {
      setAlertNote({ ok: false, text: errorText(e, "Test email failed.") });
    } finally {
      setAlertBusy(null);
    }
  };

  const ready = avail?.ready ?? [];
  const blocked = avail?.blocked ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        eyebrow={`Weekly pest counts per block for ${crop}`}
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
        <CardContent className="space-y-4" aria-busy={loading || weeksLoading || undefined}>
          {/* While availability loads the pickers stand, disabled, with a bar
              where the choice will be — the same row the data fills in. */}
          {!loading && ready.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No farm growing {crop} has blocks set up yet, so there is nothing to
              report on.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label>Farm</Label>
                <PlaceMultiPicker
                  remember={false}
                  farms={ready.map((f) => f.farm)}
                  counts={Object.fromEntries(ready.map((f) => [f.farm, f.blocks]))}
                  label="Block report farm"
                  value={places}
                  onChange={(p) => {
                    picked.current = true;
                    setPlaces(p);
                  }}
                  disabled={loading}
                />
                {(() => {
                  const n = selFarms.length ? selFarms.reduce((t, f) => t + (ready.find((r) => r.farm === f)?.blocks ?? 0), 0) : undefined;
                  return n !== undefined ? (
                    <span className="block text-xs text-muted-foreground">{n} blocks</span>
                  ) : null;
                })()}
              </div>

              <div className="space-y-1">
                <Label>Week</Label>
                <Select value={week} onValueChange={setWeek} disabled={loading || weeksLoading}>
                  <SelectTrigger className="w-72">
                    <SelectValue
                      placeholder={
                        loading || weeksLoading ? (
                          <TextSkeleton width="20ch" />
                        ) : weeks.length ? (
                          "Pick a week"
                        ) : (
                          "No scouting on this farm yet"
                        )
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> Cumulative threshold email
          </CardTitle>
          <CardDescription>
            A block is too large to cover in a day, so it is judged on its whole scouting round:
            the cumulative count of a pest divided by the block&rsquo;s hectares. When that passes
            the pest&rsquo;s threshold, one email goes to that farm&rsquo;s company: its spray plan
            creators and managers. One per block, pest and ISO week (Monday to Sunday). Preview it here, or send a test to yourself only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={previewAlert} disabled={alertBusy !== null}>
              {alertBusy === "preview" ? "Building…" : "Preview"}
            </Button>
            <Button onClick={testAlert} disabled={alertBusy !== null}>
              {alertBusy === "test" ? "Sending…" : "Send test to me"}
            </Button>
            {alertNote && (
              <span className={`text-sm ${alertNote.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {alertNote.text}
              </span>
            )}
          </div>
          {previewHtml && (
            <iframe
              title="Cumulative threshold email preview"
              srcDoc={previewHtml}
              sandbox=""
              className="h-[760px] w-full rounded-md border"
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4" /> End-of-week report email
          </CardTitle>
          <CardDescription>
            Every Monday at 07:00 the previous ISO week goes to each farm&rsquo;s spray plan creators and managers:
            every block&rsquo;s cumulative count per hectare for each pest and disease against its threshold, the
            alerts already sent, blocks with no area and the totals, with the block workbook attached. Crops with
            cumulative alerts paused send nothing. Preview it here, or send a test to yourself only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={previewWeekly} disabled={wkBusy !== null || !farm}>
              {wkBusy === "preview" ? "Building…" : "Preview"}
            </Button>
            <Button onClick={testWeekly} disabled={wkBusy !== null || !farm}>
              {wkBusy === "test" ? "Sending…" : "Send test to me"}
            </Button>
            {wkNote && (
              <span className={`text-sm ${wkNote.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {wkNote.text}
              </span>
            )}
          </div>
          {wkHtml && (
            <iframe
              title="End-of-week report email preview"
              srcDoc={wkHtml}
              sandbox=""
              className="h-[760px] w-full rounded-md border"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
