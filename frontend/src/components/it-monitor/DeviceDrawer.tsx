import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bar, TableRowsSkeleton } from "@/components/Loading";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  deviceLabel, deviceModel, fetchDevice, formatBytes, queueLabel, queueRows, relativeTime, shortPath, batteryPct,
  type ItEvent,
} from "@/lib/it-monitor-api";
import { BatteryCell, ErrorLine, StatusBadge, StorageCell, VersionBadge, useLoad } from "./parts";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-[var(--sd-quiet)]">{label}</dt>
      <dd className="truncate text-xs">{children || "-"}</dd>
    </div>
  );
}

export function EventLine({ e }: { e: ItEvent }) {
  const [open, setOpen] = useState(false);
  const hasMore = !!(e.stack || e.req_error);
  const tone = e.fatal || e.level === "fatal" || e.level === "error" ? "text-[var(--sd-data-red)]" : e.level === "warning" ? "text-[var(--sd-data-amber)]" : "text-muted-foreground";
  return (
    <li className="py-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="w-20 shrink-0 text-muted-foreground">{relativeTime(e.ts)}</span>
        <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", tone)}>{e.fatal ? "crash" : e.kind}</Badge>
        {e.count > 1 ? <span className="text-muted-foreground tabular-nums">x{e.count}</span> : null}
        <span className="min-w-0 flex-1 break-words">
          {e.req_url ? `${e.req_method ?? ""} ${shortPath(e.req_url)} ${e.req_status ?? ""}`.trim() : e.message || e.error_name || "(no message)"}
        </span>
        {hasMore ? (
          <button type="button" className="text-[11px] underline text-muted-foreground" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : "details"}
          </button>
        ) : null}
      </div>
      {e.screen || e.app_version ? (
        <div className="pl-[5.5rem] text-[11px] text-muted-foreground">
          {[e.screen && `screen ${e.screen}`, e.app_version && `v${e.app_version}`, e.req_duration_ms !== null && `${e.req_duration_ms} ms`].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      {open ? (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-[var(--sd-bg-soft)] p-2 text-[11px] leading-snug whitespace-pre-wrap">
          {[e.message, e.req_error, e.stack].filter(Boolean).join("\n\n")}
        </pre>
      ) : null}
    </li>
  );
}

export function DeviceDrawer({
  installId, latest, onClose,
}: {
  installId: string | null;
  latest: string | null;
  onClose: () => void;
}) {
  const { data, loading, error } = useLoad(() => (installId ? fetchDevice(installId) : Promise.resolve(null)), installId ?? "");
  const d = data?.device ?? null;
  const events = data?.events ?? [];
  const queues = d ? queueRows(d.queues) : [];
  const snapshot = d?.snapshot ? Object.entries(d.snapshot).filter(([, v]) => v !== null && typeof v !== "object") : [];
  return (
    <Dialog open={!!installId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        data-testid="device-drawer"
        className="!left-auto !right-0 !top-0 h-svh max-h-svh w-full max-w-xl !translate-x-0 !translate-y-0 content-start overflow-y-auto sm:rounded-none"
      >
        <div>
          <DialogTitle className="text-lg font-semibold">{d ? deviceLabel(d) : "Device"}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {d ? `${deviceModel(d)} · ${d.platform ?? ""} ${d.os_version ?? ""}` : installId}
          </DialogDescription>
        </div>
        <ErrorLine error={error} />
        {!d ? (
          <div className="flex flex-col gap-2" aria-busy="true"><Bar className="h-4 w-2/3" /><Bar className="h-4 w-1/2" /><Bar className="h-24 w-full" /></div>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              <Fact label="Status"><StatusBadge status={d.status} /></Fact>
              <Fact label="App version"><VersionBadge version={d.app_version} latest={latest} /></Fact>
              <Fact label="Runtime">{d.runtime_version}</Fact>
              <Fact label="Channel">{d.channel}</Fact>
              <Fact label="Build">{d.build_type}</Fact>
              <Fact label="Update id">{d.update_id?.slice(0, 8)}</Fact>
              <Fact label="Previous version">{d.previous_app_version ? `${d.previous_app_version} (${relativeTime(d.version_changed_at)})` : null}</Fact>
              <Fact label="User">{d.user}</Fact>
              <Fact label="Employee">{d.employee_name ?? d.employee}</Fact>
              <Fact label="Farm">{d.farm}</Fact>
              <Fact label="App role">{d.app_role}</Fact>
              <Fact label="First seen">{relativeTime(d.first_seen)}</Fact>
              <Fact label="Last seen">{relativeTime(d.last_seen)}</Fact>
              <Fact label="Last login">{relativeTime(d.last_login_at)}</Fact>
              <Fact label="Launches">{String(d.launches)}</Fact>
              <Fact label="Battery"><BatteryCell d={d} /></Fact>
              <Fact label="Power saver">{d.low_power ? "on" : "off"}</Fact>
              <Fact label="Free storage"><StorageCell d={d} /></Fact>
              <Fact label="Total storage">{formatBytes(d.storage_total_bytes)}</Fact>
              <Fact label="Memory">{formatBytes(d.memory_total_bytes)}</Fact>
              <Fact label="Network">{[d.network_type, d.connectivity].filter(Boolean).join(" · ")}</Fact>
              <Fact label="Clock skew">{d.clock_skew_seconds !== null ? `${d.clock_skew_seconds} s` : null}</Fact>
              <Fact label="IP">{d.ip_address}</Fact>
              <Fact label="Last sync">{relativeTime(d.last_sync_at)}</Fact>
              <Fact label="Last good sync">{relativeTime(d.last_sync_ok_at)}</Fact>
            </dl>
            {d.last_sync_error ? (
              <p className="rounded-md bg-[var(--sd-bg-soft)] p-2 text-xs text-[var(--sd-data-red)]">Last sync error: {d.last_sync_error}</p>
            ) : null}
            {d.it_notes ? <p className="text-xs text-muted-foreground">Notes: {d.it_notes}</p> : null}

            <section>
              <h4 className="mb-1 text-sm font-semibold">Queues</h4>
              {queues.length === 0 ? (
                <p className="text-xs text-muted-foreground">The phone has not reported its queues yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Queue</TableHead><TableHead>Pending</TableHead><TableHead>Failed</TableHead>
                      <TableHead>Held</TableHead><TableHead>Refused</TableHead><TableHead>Oldest</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queues.map((q) => (
                      <TableRow key={q.name}>
                        <TableCell>{queueLabel(q.name)}</TableCell>
                        <TableCell className="tabular-nums">{q.pending}</TableCell>
                        <TableCell className={cn("tabular-nums", q.failed > 0 && "text-[var(--sd-data-red)]")}>{q.failed}</TableCell>
                        <TableCell className={cn("tabular-nums", q.held > 0 && "text-[var(--sd-data-red)]")}>{q.held}</TableCell>
                        <TableCell className={cn("tabular-nums", q.refused > 0 && "text-[var(--sd-data-red)]")}>{q.refused}</TableCell>
                        <TableCell>{q.oldest_at ? relativeTime(q.oldest_at) : "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            {snapshot.length ? (
              <section>
                <h4 className="mb-1 text-sm font-semibold">Device snapshot</h4>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                  {snapshot.map(([k, v]) => (
                    <Fact key={k} label={k.replace(/_/g, " ")}>{k.includes("bytes") ? formatBytes(Number(v)) : k === "battery_level" ? `${batteryPct(Number(v))}%` : String(v)}</Fact>
                  ))}
                </dl>
              </section>
            ) : null}

            <section>
              <h4 className="mb-1 text-sm font-semibold">Event timeline</h4>
              {loading && events.length === 0 ? (
                <Table><TableBody><TableRowsSkeleton cols={3} rows={4} /></TableBody></Table>
              ) : events.length === 0 ? (
                <p className="text-xs text-muted-foreground">No events recorded for this phone.</p>
              ) : (
                <ul className="divide-y">{events.map((e) => <EventLine key={e.event_id} e={e} />)}</ul>
              )}
            </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
