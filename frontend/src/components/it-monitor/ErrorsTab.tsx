import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TableRowsSkeleton, firstLoad } from "@/components/Loading";
import { fetchIssueEvents, relativeTime, type ItIssue } from "@/lib/it-monitor-api";
import { EventLine } from "./DeviceDrawer";
import { Empty, ErrorLine, useLoad } from "./parts";

function IssueEvents({ fingerprint, days }: { fingerprint: string; days: number }) {
  const { data, loading, error } = useLoad(() => fetchIssueEvents(fingerprint, days), `${fingerprint}:${days}`);
  if (error) return <ErrorLine error={error} />;
  if (loading && !data) return <p className="text-xs text-muted-foreground">Loading events...</p>;
  if (!data?.length) return <p className="text-xs text-muted-foreground">No events in this period.</p>;
  return <ul className="divide-y">{data.map((e) => <EventLine key={e.event_id} e={e} />)}</ul>;
}

export function ErrorsTab({ rows, loading, days }: { rows: ItIssue[] | null; loading: boolean; days: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const first = firstLoad(loading, !!rows);
  if (!first && (rows ?? []).length === 0) return <Empty>No errors reported in this period.</Empty>;
  return (
    <div className="overflow-x-auto rounded-xl bg-card shadow-[var(--sd-shadow-1)]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-6" />
            <TableHead>Issue</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Events</TableHead>
            <TableHead>Users</TableHead>
            <TableHead>Devices</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Last version</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {first ? (
            <TableRowsSkeleton cols={9} rows={6} />
          ) : (
            (rows ?? []).flatMap((i) => {
              const expanded = open === i.fingerprint;
              return [
                <TableRow key={i.fingerprint} className="cursor-pointer" onClick={() => setOpen(expanded ? null : i.fingerprint)}>
                  <TableCell>{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                  <TableCell className="max-w-[28rem] truncate font-medium" title={i.title}>{i.title}</TableCell>
                  <TableCell><Badge variant="outline" className="px-1.5 py-0 text-[10px]">{i.kind}</Badge></TableCell>
                  <TableCell className="tabular-nums">{i.events}</TableCell>
                  <TableCell className="tabular-nums">{i.users}</TableCell>
                  <TableCell className="tabular-nums">{i.devices}</TableCell>
                  <TableCell className="whitespace-nowrap">{relativeTime(i.first_seen)}</TableCell>
                  <TableCell className="whitespace-nowrap">{relativeTime(i.last_seen)}</TableCell>
                  <TableCell className="tabular-nums">{i.last_version ?? "-"}</TableCell>
                </TableRow>,
                expanded ? (
                  <TableRow key={`${i.fingerprint}:events`} className="hover:bg-transparent">
                    <TableCell />
                    <TableCell colSpan={8}><IssueEvents fingerprint={i.fingerprint} days={days} /></TableCell>
                  </TableRow>
                ) : null,
              ];
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
