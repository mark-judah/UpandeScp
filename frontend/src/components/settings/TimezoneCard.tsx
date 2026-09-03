/**
 * Timezone — read ERPNext's, show it, and guard changes.
 *
 * The reason this screen exists at all: kaitet ran its whole life on Frappe's
 * out-of-the-box `Asia/Kolkata` while every farm is Kenyan, so every timestamp was
 * 2h30m ahead of local time and the daily report fired at 11:30 Nairobi. Nothing
 * surfaced it, because a clock that is consistently wrong looks like a working clock.
 * So the card leads with the comparison — configured vs where the farms actually are —
 * rather than burying it under a control.
 *
 * The ERPNext value is deliberately **not editable here**. It governs stored
 * timestamps, notification timing and the scheduler's cron clock; a second place to
 * change it is a second place for the two to disagree. The app override is offered
 * because it was asked for, and labelled with exactly what it does and does not do.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, Lock, LockOpen } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FrappeError } from "@/lib/frappe";
import { errorText } from "@/lib/errors";
import {
  fetchAvailableTimezones,
  fetchTimezoneReport,
  setAppTimezone,
  setTimezoneLock,
  type TimezoneReport,
} from "@/lib/settings-api";

const FOLLOW = "__follow_erp__";

function errText(e: unknown): string {
  if (e instanceof FrappeError) return e.message;
  return errorText(e);
}

export function TimezoneCard() {
  const [report, setReport] = useState<TimezoneReport | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [choice, setChoice] = useState<string>(FOLLOW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, z] = await Promise.all([
      fetchTimezoneReport(),
      fetchAvailableTimezones(),
    ]);
    setReport(r);
    setZones(z);
    setChoice(r && !r.follows_erp ? r.app_timezone : FOLLOW);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!report) return null;

  const mismatch =
    !!report.expected_timezone && report.expected_timezone !== report.erp_timezone;

  async function run(fn: () => Promise<TimezoneReport>, ok: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      setReport(out);
      setChoice(out.follows_erp ? FOLLOW : out.app_timezone);
      setNotice(ok);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4" /> Timezone
        </CardTitle>
        <CardDescription>
          ERPNext&apos;s timezone governs every timestamp this app writes, all
          notification timing, and the clock the scheduler runs cron against. It is
          shown here, not editable here — a second place to change it is a second place
          for the two to disagree.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              ERPNext (governs everything)
            </div>
            <div className="mt-1 font-medium">{report.erp_timezone}</div>
            <div className="text-xs text-muted-foreground">{report.erp_offset}</div>
          </div>
          <div
            className={cn(
              "rounded-lg border p-3",
              mismatch && "border-destructive/50 bg-destructive/5",
            )}
          >
            <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              Where the farms are
            </div>
            <div className="mt-1 font-medium">
              {report.expected_timezone || "unknown"}
            </div>
            <div className="text-xs text-muted-foreground">
              {report.expected_offset || "no coordinates to infer from"}
            </div>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
              This app displays
            </div>
            <div className="mt-1 font-medium">{report.app_timezone}</div>
            <div className="text-xs text-muted-foreground">
              {report.follows_erp ? "following ERPNext" : "overridden"}
            </div>
          </div>
        </div>

        {report.warnings.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            {report.warnings.map((w) => (
              <p
                key={w}
                className="flex items-start gap-2 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{w}</span>
              </p>
            ))}
            {mismatch && (
              <p className="pl-6 text-xs text-muted-foreground">
                Fix it in ERPNext under Settings → System Settings → Time Zone. It is
                not changed from here on purpose: re-timing a live site&apos;s
                notifications and scheduled reports should be a deliberate act in the
                place that owns the setting.
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div>
            ERPNext clock
            <div className="font-mono text-foreground">{report.now_erp.slice(0, 19)}</div>
          </div>
          <div>
            UTC
            <div className="font-mono text-foreground">{report.now_utc}</div>
          </div>
          <div>
            App clock
            <div className="font-mono text-foreground">
              {report.now_app?.slice(0, 19) || "—"}
            </div>
          </div>
        </div>

        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {report.locked ? (
                <Lock className="size-4 text-muted-foreground" />
              ) : (
                <LockOpen className="size-4 text-amber-600" />
              )}
              <span className="text-sm font-medium">
                {report.locked ? "Locked" : "Unlocked"}
              </span>
              <Badge variant="secondary" className="text-[0.65rem]">
                {report.locked ? "changes refused" : "changes allowed"}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(
                  () => setTimezoneLock(!report.locked),
                  report.locked
                    ? "Unlocked. Lock it again once you are done."
                    : "Locked.",
                )
              }
            >
              {report.locked ? "Unlock to change" : "Lock again"}
            </Button>
          </div>
          <p className="mt-2 text-[0.65rem] leading-snug text-muted-foreground">
            Locked by default. A changed timezone re-times every notification,
            scheduled report and spray deadline with no error appearing anywhere, so it
            takes a deliberate unlock. Every change is written to the Error Log under
            &ldquo;SCP timezone changed&rdquo;.
          </p>
        </div>

        <div>
          <Label className="text-[0.7rem]">App display timezone</Label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Select value={choice} onValueChange={setChoice} disabled={report.locked}>
              <SelectTrigger className="h-9 w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW}>
                  Follow ERPNext ({report.erp_timezone})
                </SelectItem>
                {zones.map((z) => (
                  <SelectItem key={z} value={z}>
                    {z}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              disabled={
                busy ||
                report.locked ||
                choice === (report.follows_erp ? FOLLOW : report.app_timezone)
              }
              onClick={() =>
                void run(
                  () => setAppTimezone(choice === FOLLOW ? "" : choice),
                  choice === FOLLOW
                    ? "Now following ERPNext."
                    : `Displaying times in ${choice}.`,
                )
              }
            >
              Apply
            </Button>
          </div>
          <p className="mt-1 text-[0.65rem] leading-snug text-muted-foreground">
            Almost always leave this following ERPNext. An override changes only what
            this app <strong>shows</strong> — stored timestamps, scheduled reports and
            notification timing all follow ERPNext, because they must.
          </p>
        </div>

        {(!!error || !!notice) && (
          <p
            className={cn(
              "text-sm",
              error ? "text-destructive" : "text-[var(--sd-data-green)]",
            )}
          >
            {error || notice}
          </p>
        )}

        <div>
          <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            What a change affects
          </p>
          <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
            {report.affected.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export default TimezoneCard;
