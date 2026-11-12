import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableRowsSkeleton, firstLoad } from "@/components/Loading";
import { cn } from "@/lib/utils";
import { relativeTime, type ItLogin } from "@/lib/it-monitor-api";
import { Empty } from "./parts";

export function LoginsTab({ rows, loading }: { rows: ItLogin[] | null; loading: boolean }) {
  const first = firstLoad(loading, !!rows);
  if (!first && (rows ?? []).length === 0) return <Empty>No logins in this period.</Empty>;
  return (
    <div className="overflow-x-auto rounded-xl bg-card shadow-[var(--sd-shadow-1)]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>App version</TableHead>
            <TableHead>IP</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {first ? (
            <TableRowsSkeleton cols={7} rows={8} />
          ) : (
            (rows ?? []).map((l, i) => {
              const failed = l.status.toLowerCase() !== "success";
              return (
                <TableRow key={`${l.ts}:${l.user}:${i}`}>
                  <TableCell className="whitespace-nowrap" title={l.ts ?? ""}>{relativeTime(l.ts)}</TableCell>
                  <TableCell>{l.full_name ?? l.user ?? "-"}</TableCell>
                  <TableCell>{l.operation}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("px-2 py-0 text-[11px]", failed ? "border-[var(--sd-data-red)] text-[var(--sd-data-red)]" : "border-[var(--sd-data-green)] text-[var(--sd-data-green)]")}>
                      {l.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{l.device ?? <span className="text-muted-foreground">web / unknown</span>}</TableCell>
                  <TableCell className="tabular-nums">{l.app_version ?? "-"}</TableCell>
                  <TableCell className="tabular-nums">{l.ip_address ?? "-"}</TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
