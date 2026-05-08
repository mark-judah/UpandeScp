import { useEffect, useState } from "react";
import { Mail, Download, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
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
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { LoadingStrip } from "@/components/LoadingStrip";
import { call } from "@/lib/frappe";
import { cn } from "@/lib/utils";

type Status = { kind: "ok" | "err"; text: string } | null;

interface ReportSpec {
  key: string;
  title: string;
  description: string;
  emailMethod: string;
  /** When set, downloads via window.location to a streaming endpoint. */
  downloadUrl?: (args: { farm?: string }) => string;
  /** When set, page renders a farm picker before enabling actions. */
  needsFarm?: boolean;
}

const REPORTS: ReportSpec[] = [
  {
    key: "daily",
    title: "Daily Scouting Summary",
    description:
      "Yesterday's scouting roll-up emailed to recipients configured in Scouting & Crop Protection settings.",
    emailMethod:
      "upande_scp.serverscripts.send_daily_scouting_report.trigger_daily_email",
    downloadUrl: () =>
      "/api/method/upande_scp.serverscripts.send_daily_scouting_report.download_daily_pdf",
  },
  {
    key: "weekly_trap",
    title: "Weekly Trap Report",
    description:
      "Aggregated trap counts for the prior week — emailed every Monday morning, or trigger now.",
    emailMethod:
      "upande_scp.serverscripts.send_weekly_trap_report.trigger_weekly_email",
    downloadUrl: () =>
      "/api/method/upande_scp.serverscripts.send_weekly_trap_report.download_weekly_pdf",
  },
  {
    key: "fcm",
    title: "KEPHIS FCM Weekly",
    description:
      "Per-farm FCM monitoring template for KEPHIS submission. Pick a farm before sending or downloading.",
    emailMethod:
      "upande_scp.serverscripts.send_fcm_weekly_excel_report.trigger_fcm_email",
    downloadUrl: ({ farm }) =>
      `/api/method/upande_scp.serverscripts.send_fcm_weekly_excel_report.download_fcm_xlsx?farm=${encodeURIComponent(farm || "")}`,
    needsFarm: true,
  },
];

export function Reports() {
  const [farms, setFarms] = useState<string[]>([]);
  const [farm, setFarm] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    call<string[] | { message: string[] }>(
      "upande_scp.serverscripts.send_fcm_weekly_excel_report.list_farms_with_data",
      {},
    )
      .then((r: any) => {
        const arr = Array.isArray(r) ? r : Array.isArray(r?.message) ? r.message : [];
        setFarms(arr.map((x: any) => String(x)));
        if (arr.length && !farm) setFarm(arr[0]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendEmail = async (spec: ReportSpec) => {
    if (spec.needsFarm && !farm) {
      setStatus({ kind: "err", text: "Pick a farm first." });
      return;
    }
    setBusy(`${spec.key}:email`);
    setStatus(null);
    try {
      await call(spec.emailMethod, spec.needsFarm ? { farm } : {});
      setStatus({ kind: "ok", text: `${spec.title} emailed.` });
    } catch (e: any) {
      setStatus({ kind: "err", text: e?.message || "Email failed." });
    } finally {
      setBusy(null);
    }
  };

  const download = (spec: ReportSpec) => {
    if (spec.needsFarm && !farm) {
      setStatus({ kind: "err", text: "Pick a farm first." });
      return;
    }
    if (!spec.downloadUrl) return;
    window.location.href = spec.downloadUrl({ farm });
    setStatus({ kind: "ok", text: `${spec.title} download started.` });
  };

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-6" />
        <div>
          <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
            Reports
          </h1>
          <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
            Email or download scouting summaries
          </p>
        </div>
      </header>

      {status && (
        <div
          className={cn(
            "px-4 md:px-6 py-2 text-xs flex items-center gap-2 border-b",
            status.kind === "ok"
              ? "bg-[var(--sd-data-green)]/8 text-[var(--sd-data-green)]"
              : "bg-[var(--sd-data-red)]/8 text-[var(--sd-data-red)]",
          )}
        >
          {status.kind === "ok" ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          {status.text}
          <button
            type="button"
            className="ml-auto text-[0.7rem] underline"
            onClick={() => setStatus(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex-1 px-4 md:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {REPORTS.map((r) => (
          <Card key={r.key} className="p-4 flex flex-col gap-3">
            <CardHeader className="p-0">
              <CardTitle>{r.title}</CardTitle>
              <CardDescription>{r.description}</CardDescription>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-2 mt-auto">
              {r.needsFarm && (
                <div className="flex flex-col gap-1">
                  <Label>Farm</Label>
                  <Select
                    value={farm}
                    onValueChange={setFarm}
                    disabled={!farms.length}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder={farms.length ? "Pick a farm" : "Loading…"} />
                    </SelectTrigger>
                    <SelectContent>
                      {farms.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() => sendEmail(r)}
                  disabled={busy === `${r.key}:email`}
                >
                  {busy === `${r.key}:email` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mail className="h-3.5 w-3.5" />
                  )}
                  Email
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => download(r)}
                  disabled={!r.downloadUrl}
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="px-4 md:px-6 pb-4 text-[0.7rem] text-muted-foreground">
        Daily scouting · scheduled 17:00 EAT &nbsp;·&nbsp; Weekly trap report ·
        Mondays 08:00 EAT &nbsp;·&nbsp; FCM weekly · Mondays 06:00 EAT.
      </p>

      <LoadingStrip active={busy != null} />
    </div>
  );
}
