import { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { DatePicker } from "@/components/DatePicker";
import { Button } from "@/components/ui/button";
import { LoadingStrip } from "@/components/LoadingStrip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { call } from "@/lib/frappe";
import { ymd } from "@/lib/utils";
import { cn } from "@/lib/utils";

const ALL = "__all__";

interface WorkOrderRow {
  name: string;
  item_name?: string;
  qty?: number;
  stock_uom?: string;
  custom_greenhouse?: string;
  custom_variety?: string;
  custom_scope?: string;
  custom_spray_type?: string;
  custom_kit?: string;
  custom_scheduled_application_time?: string;
  custom_area?: number;
  docstatus: number;
  status_label: string;
  status_state: "pending" | "approved" | "cancelled";
}

const STATUS_TONE: Record<string, string> = {
  pending: "border-[var(--sd-target)] text-[var(--sd-target)]",
  approved: "border-[var(--sd-data-green)] text-[var(--sd-data-green)]",
  cancelled: "border-[var(--sd-data-red)] text-[var(--sd-data-red)]",
};

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

export function Historical() {
  const [from, setFrom] = useState(defaultRange().from);
  const [to, setTo] = useState(defaultRange().to);
  const [farm, setFarm] = useState(ALL);
  const [greenhouse, setGreenhouse] = useState(ALL);
  const [status, setStatus] = useState("");
  const [data, setData] = useState<{
    work_orders: WorkOrderRow[];
    greenhouses: string[];
    farms: string[];
  }>({ work_orders: [], greenhouses: [], farms: [] });
  const [loading, setLoading] = useState(true);
  const [openName, setOpenName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    call<typeof data>(
      "upande_scp.serverscripts.scouting_metrics_api.list_application_work_orders",
      {
        from_date: from,
        to_date: to,
        farm: farm === ALL ? undefined : farm,
        greenhouse: greenhouse === ALL ? undefined : greenhouse,
        status: status || undefined,
      },
    )
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [from, to, farm, greenhouse, status]);

  const ghOpts = useMemo(
    () =>
      farm === ALL
        ? data.greenhouses
        : data.greenhouses.filter((g) => g.includes(farm)),
    [data.greenhouses, farm],
  );

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Application Work Orders
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Historical · {data.work_orders.length} records
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
              <Select
                value={farm}
                onValueChange={(v) => {
                  setFarm(v);
                  setGreenhouse(ALL);
                }}
              >
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
            <div className="flex flex-col gap-1 min-w-40">
              <Label>Greenhouse</Label>
              <Select value={greenhouse} onValueChange={setGreenhouse}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All Greenhouses</SelectItem>
                  {ghOpts.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1 min-w-32">
              <Label>Status</Label>
              <Select
                value={status || ALL}
                onValueChange={(v) => setStatus(v === ALL ? "" : v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 md:px-6 py-4">
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Work Order</TableHead>
                <TableHead>Greenhouse · Variety</TableHead>
                <TableHead>Scope · Spray</TableHead>
                <TableHead className="text-right">Area</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.work_orders.map((w) => (
                <TableRow
                  key={w.name}
                  onClick={() => setOpenName(w.name)}
                  className="cursor-pointer"
                >
                  <TableCell>
                    <div className="font-medium text-xs">{w.name}</div>
                    <div className="text-[0.65rem] text-muted-foreground">
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
                  <TableCell className="text-right tabular-nums text-xs">
                    {w.custom_area != null ? `${w.custom_area} m²` : "—"}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {w.custom_scheduled_application_time
                      ? w.custom_scheduled_application_time.slice(0, 16)
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[0.6rem] capitalize",
                        STATUS_TONE[w.status_state],
                      )}
                    >
                      {w.status_label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ))}
              {!data.work_orders.length && !loading && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-xs text-muted-foreground text-center py-8"
                  >
                    No work orders match the selected filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      <WorkOrderDialog
        name={openName}
        onClose={() => setOpenName(null)}
      />
      <LoadingStrip active={loading} />
    </div>
  );
}

function WorkOrderDialog({
  name,
  onClose,
}: {
  name: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!name) {
      setData(null);
      return;
    }
    setLoading(true);
    call<any>(
      "upande_scp.serverscripts.scouting_metrics_api.get_application_work_order",
      { name },
    )
      .then(setData)
      .finally(() => setLoading(false));
  }, [name]);

  const wo = data?.work_order;
  const chemicals: any[] = data?.chemicals || [];

  return (
    <Dialog open={!!name} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name || "Work Order"}</DialogTitle>
          <DialogDescription>
            {data?.status_label || (loading ? "Loading…" : "")}
            {wo?.custom_greenhouse && ` · ${wo.custom_greenhouse}`}
          </DialogDescription>
        </DialogHeader>

        {wo && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
            <Cell label="Variety" value={wo.custom_variety} />
            <Cell label="Scope" value={wo.custom_scope} />
            <Cell label="Spray Type" value={wo.custom_spray_type} />
            <Cell label="Kit" value={wo.custom_kit} />
            <Cell
              label="Scheduled"
              value={wo.custom_scheduled_application_time?.slice(0, 16)}
            />
            <Cell
              label="Area"
              value={wo.custom_area != null ? `${wo.custom_area} m²` : "—"}
            />
          </div>
        )}

        <Card className="p-3 shadow-none border">
          <CardHeader className="p-0 pb-2">
            <CardTitle className="text-sm">Chemical Mix</CardTitle>
            <CardDescription>
              {chemicals.length} chemical
              {chemicals.length !== 1 ? "s" : ""} from BOM {wo?.bom_no || "—"}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {chemicals.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chemical</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>UOM</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {chemicals.map((c, i) => (
                    <TableRow key={c.item_code + i}>
                      <TableCell className="text-xs">
                        <div className="font-medium">{c.item_name || c.item_code}</div>
                        <div className="text-muted-foreground text-[0.65rem] font-mono">
                          {c.item_code}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {c.stock_qty ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">{c.stock_uom || ""}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {c.rate ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {c.amount ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="text-xs text-muted-foreground py-4 text-center">
                {loading ? "Loading…" : "No chemicals on this BOM."}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <a
              href={`/app/work-order/${encodeURIComponent(name || "")}`}
              target="_blank"
              rel="noreferrer"
            >
              Open in Desk
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Cell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="px-2 py-1.5 rounded bg-[var(--sd-bg-soft)] border">
      <div className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs font-medium tabular-nums truncate">
        {value || "—"}
      </div>
    </div>
  );
}
