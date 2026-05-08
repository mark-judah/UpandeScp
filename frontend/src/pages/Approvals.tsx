import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { DatePicker } from "@/components/DatePicker";
import { LoadingStrip } from "@/components/LoadingStrip";
import { call } from "@/lib/frappe";
import { ymd } from "@/lib/utils";

const ALL = "__all__";

interface WorkOrderRow {
  name: string;
  item_name?: string;
  custom_greenhouse?: string;
  custom_variety?: string;
  custom_scope?: string;
  custom_spray_type?: string;
  custom_scheduled_application_time?: string;
  custom_area?: number;
  docstatus: number;
  status_state: "pending" | "approved" | "cancelled";
  status_label: string;
}

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 7);
  return { from: ymd(from), to: ymd(today) };
}

export function Approvals() {
  const [from, setFrom] = useState(defaultRange().from);
  const [to, setTo] = useState(defaultRange().to);
  const [farm, setFarm] = useState(ALL);
  const [data, setData] = useState<{
    work_orders: WorkOrderRow[];
    farms: string[];
  }>({ work_orders: [], farms: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"pending" | "approved" | "all">("pending");

  const reload = () => {
    setLoading(true);
    return call<typeof data>(
      "upande_scp.serverscripts.scouting_metrics_api.list_application_work_orders",
      {
        from_date: from,
        to_date: to,
        farm: farm === ALL ? undefined : farm,
      },
    )
      .then(setData)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, farm]);

  const filteredByTab = useMemo(() => {
    if (tab === "all") return data.work_orders;
    return data.work_orders.filter((w) => w.status_state === tab);
  }, [data.work_orders, tab]);

  const counts = useMemo(() => {
    let pending = 0,
      approved = 0;
    data.work_orders.forEach((w) => {
      if (w.status_state === "pending") pending++;
      if (w.status_state === "approved") approved++;
    });
    return { pending, approved, all: data.work_orders.length };
  }, [data.work_orders]);

  const approve = async (name: string) => {
    setBusy(name);
    try {
      await call(
        "upande_scp.serverscripts.scouting_metrics_api.submit_application_work_order",
        { name },
      );
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (name: string) => {
    setBusy(name);
    try {
      await call(
        "upande_scp.serverscripts.scouting_metrics_api.cancel_application_work_order",
        { name },
      );
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Approvals
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Application Work Orders awaiting approval
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label>From</Label>
              <DatePicker value={from} onChange={setFrom} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>To</Label>
              <DatePicker value={to} onChange={setTo} />
            </div>
            <div className="flex flex-col gap-1 min-w-32">
              <Label>Farm</Label>
              <Select value={farm} onValueChange={setFarm}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All Farms</SelectItem>
                  {data.farms.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as any)}
        className="flex flex-col gap-3 px-4 md:px-6 py-4 flex-1"
      >
        <TabsList className="self-start">
          <TabsTrigger value="pending">Pending · {counts.pending}</TabsTrigger>
          <TabsTrigger value="approved">Approved · {counts.approved}</TabsTrigger>
          <TabsTrigger value="all">All · {counts.all}</TabsTrigger>
        </TabsList>

        <TabsContent value={tab}>
          <Card className="p-0">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Work Order</TableHead>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead>Spray</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredByTab.map((w) => (
                    <TableRow key={w.name}>
                      <TableCell className="text-xs">
                        <div className="font-medium">{w.name}</div>
                        <div className="text-muted-foreground text-[0.65rem]">
                          {w.item_name || ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-medium truncate max-w-[14rem]">
                          {w.custom_greenhouse}
                        </div>
                        <div className="text-muted-foreground">
                          {w.custom_variety || ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div>{w.custom_scope || "—"}</div>
                        <div className="text-muted-foreground">
                          {w.custom_spray_type || ""}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {w.custom_scheduled_application_time?.slice(0, 16) || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-[0.6rem] capitalize">
                          {w.status_label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1.5">
                          {w.status_state === "pending" && (
                            <Button
                              size="sm"
                              variant="default"
                              className="h-7 text-[0.7rem]"
                              onClick={() => approve(w.name)}
                              disabled={busy === w.name}
                            >
                              {busy === w.name ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3 w-3" />
                              )}
                              Approve
                            </Button>
                          )}
                          {w.status_state === "approved" && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-[0.7rem]"
                              onClick={() => cancel(w.name)}
                              disabled={busy === w.name}
                            >
                              {busy === w.name ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <XCircle className="h-3 w-3" />
                              )}
                              Cancel
                            </Button>
                          )}
                          <a
                            href={`/app/work-order/${encodeURIComponent(w.name)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            title="Open in Desk"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!filteredByTab.length && !loading && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="text-xs text-muted-foreground text-center py-8"
                      >
                        Nothing here for this filter.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <LoadingStrip active={loading} />
    </div>
  );
}
