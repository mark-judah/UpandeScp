import { useMemo } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableRowsSkeleton, firstLoad } from "@/components/Loading";
import { deviceLabel, deviceModel, relativeTime, type ItDevice } from "@/lib/it-monitor-api";
import { BatteryCell, NoDevicesYet, PendingCell, StatusBadge, StorageCell, VersionBadge, Empty } from "./parts";

export function DevicesTab({
  rows, loading, latest, filtered, onOpen,
}: {
  rows: ItDevice[] | null;
  loading: boolean;
  latest: string | null;
  /** true when any filter narrows the list (so an empty list is not "no phones") */
  filtered: boolean;
  onOpen: (installId: string) => void;
}) {
  const first = firstLoad(loading, !!rows);
  const list = useMemo(() => rows ?? [], [rows]);
  if (!first && list.length === 0) return filtered ? <Empty>No devices match these filters.</Empty> : <NoDevicesYet />;
  return (
    <div className="overflow-x-auto rounded-xl bg-card shadow-[var(--sd-shadow-1)]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Farm</TableHead>
            <TableHead>App role</TableHead>
            <TableHead>App version</TableHead>
            <TableHead>Runtime</TableHead>
            <TableHead>Battery</TableHead>
            <TableHead>Free storage</TableHead>
            <TableHead>Network</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Pending / stuck</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {first ? (
            <TableRowsSkeleton cols={10} rows={8} />
          ) : (
            list.map((d) => (
              <TableRow key={d.install_id} className="cursor-pointer" onClick={() => onOpen(d.install_id)}>
                <TableCell>
                  <button type="button" className="text-left" onClick={() => onOpen(d.install_id)}>
                    <div className="flex items-center gap-2 font-medium">
                      {deviceLabel(d)}
                      <StatusBadge status={d.status} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">{deviceModel(d)}</div>
                  </button>
                </TableCell>
                <TableCell>{d.farm ?? "-"}</TableCell>
                <TableCell className="capitalize">{d.app_role ?? "-"}</TableCell>
                <TableCell><VersionBadge version={d.app_version} latest={latest} /></TableCell>
                <TableCell className="tabular-nums">{d.runtime_version ?? "-"}</TableCell>
                <TableCell><BatteryCell d={d} /></TableCell>
                <TableCell><StorageCell d={d} /></TableCell>
                <TableCell>{d.network_type ?? d.connectivity ?? "-"}</TableCell>
                <TableCell className="whitespace-nowrap">{relativeTime(d.last_seen)}</TableCell>
                <TableCell><PendingCell d={d} /></TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
