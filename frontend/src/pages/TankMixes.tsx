import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { LoadingStrip } from "@/components/LoadingStrip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { call } from "@/lib/frappe";

const ALL_FARMS = "__all__";

interface ChemicalRow {
  item_code: string;
  item_name?: string;
  stock_qty?: number;
  stock_uom?: string;
  rate?: number;
  amount?: number;
}

interface TankMix {
  name: string;
  item: string;
  item_name?: string;
  custom_farm?: string;
  custom_business_unit?: string;
  custom_water_ph?: number;
  custom_water_hardness?: number;
  uom?: string;
  quantity?: number;
  is_active?: number;
  is_default?: number;
  modified: string;
  modified_by?: string;
  chemicals: ChemicalRow[];
  item_count: number;
  total_amount: number;
}

export function TankMixes() {
  const [q, setQ] = useState("");
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [activeOnly, setActiveOnly] = useState(true);
  const [data, setData] = useState<{ tank_mixes: TankMix[]; farms: string[] }>({
    tank_mixes: [],
    farms: [],
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    call<{ tank_mixes: TankMix[]; farms: string[] }>(
      "upande_scp.serverscripts.scouting_metrics_api.list_tank_mixes",
      {
        farm: farm === ALL_FARMS ? undefined : farm,
        q: q || undefined,
        active_only: activeOnly ? 1 : 0,
      },
    )
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [q, farm, activeOnly]);

  const farms = useMemo(() => data.farms || [], [data]);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Tank Mixes
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Chemical Mix BOMs · {data.tank_mixes.length} loaded
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-56">
              <Label>Search</Label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by item…"
                  className="h-9 pl-7"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1 min-w-32">
              <Label>Farm</Label>
              <Select value={farm} onValueChange={setFarm}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FARMS}>All Farms</SelectItem>
                  {farms.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1 min-w-32">
              <Label>Status</Label>
              <Select
                value={activeOnly ? "active" : "all"}
                onValueChange={(v) => setActiveOnly(v === "active")}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active only</SelectItem>
                  <SelectItem value="all">All mixes</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 md:px-6 py-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {data.tank_mixes.length === 0 && !loading && (
          <Card className="p-8 text-center col-span-full">
            <CardTitle className="text-sm">No tank mixes match</CardTitle>
            <CardDescription className="mt-1">
              Try widening the filters.
            </CardDescription>
          </Card>
        )}

        {data.tank_mixes.map((tm) => (
          <Card key={tm.name} className="p-4 flex flex-col gap-3">
            <CardHeader className="p-0">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="truncate">
                  {tm.item_name || tm.item}
                </CardTitle>
                {tm.is_default ? (
                  <Badge variant="default" className="text-[0.6rem]">
                    default
                  </Badge>
                ) : tm.is_active ? (
                  <Badge variant="outline" className="text-[0.6rem]">
                    active
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[0.6rem]">
                    inactive
                  </Badge>
                )}
              </div>
              <CardDescription className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-[0.7rem] text-muted-foreground">
                  {tm.name}
                </code>
                {tm.custom_farm && (
                  <Badge variant="outline" className="text-[0.6rem]">
                    {tm.custom_farm}
                  </Badge>
                )}
                {tm.custom_business_unit && (
                  <Badge variant="outline" className="text-[0.6rem]">
                    {tm.custom_business_unit}
                  </Badge>
                )}
              </CardDescription>
            </CardHeader>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <Stat label="Mix size" value={`${tm.quantity || 0} ${tm.uom || ""}`} />
              <Stat label="Chemicals" value={String(tm.item_count)} />
              <Stat label="Water pH" value={tm.custom_water_ph ?? "—"} />
              <Stat
                label="Hardness"
                value={tm.custom_water_hardness ?? "—"}
              />
            </div>

            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chemical</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>UOM</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tm.chemicals.length ? (
                    tm.chemicals.slice(0, 8).map((c) => (
                      <TableRow key={c.item_code}>
                        <TableCell className="text-xs">
                          <div className="font-medium truncate">
                            {c.item_name || c.item_code}
                          </div>
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
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={4} className="text-xs text-muted-foreground">
                        No chemicals on this BOM.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>

            <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground mt-auto">
              <span>Last updated {tm.modified.slice(0, 16)}</span>
              <a
                href={`/app/bom/${encodeURIComponent(tm.name)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                <ExternalLink className="h-3 w-3" />
                Open BOM
              </a>
            </div>
          </Card>
        ))}
      </div>

      <LoadingStrip active={loading} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-2 py-1.5 rounded bg-[var(--sd-bg-soft)] border">
      <div className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}
