import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Layers } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL } from "@/components/header-controls";
import { TreePicker } from "@/components/TreePicker";
import type { TreeNode } from "@/pages/trends/trends-types";
import { PlacePicker } from "@/components/PlacePicker";
import { LoadingStrip } from "@/components/LoadingStrip";
import {
  KpiValueSkeleton,
  TableRowsSkeleton,
  TextSkeleton,
  firstLoad,
} from "@/components/Loading";
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

const NO_FARM = "No farm";
const farmId = (f: string) => `farm:${f}`;
const itemId = (f: string, item: string) => `item:${f}|${item}`;

/** Farm -> item tree built from the loaded tank mixes. */
export function buildItemTree(mixes: TankMix[]): TreeNode[] {
  const byFarm = new Map<string, Map<string, string>>();
  for (const tm of mixes) {
    const f = tm.custom_farm || NO_FARM;
    if (!byFarm.has(f)) byFarm.set(f, new Map());
    byFarm.get(f)!.set(tm.item, tm.item_name || tm.item);
  }
  return [...byFarm.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, items]) => ({
      id: farmId(f),
      label: f,
      children: [...items.entries()]
        .sort(([, a], [, b]) => a.localeCompare(b))
        .map(([code, name]) => ({ id: itemId(f, code), label: name, search: `${name} ${code}` })),
    }));
}

/** A mix shows when its farm or its (farm, item) leaf is picked. */
export function matchesPicked(tm: TankMix, picked: Set<string>): boolean {
  const f = tm.custom_farm || NO_FARM;
  return picked.has(farmId(f)) || picked.has(itemId(f, tm.item));
}

export function TankMixes() {
  // Multi-level item filter (farm -> item). Empty = everything.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [activeOnly, setActiveOnly] = useState(true);
  const [data, setData] = useState<{ tank_mixes: TankMix[]; farms: string[] }>({
    tank_mixes: [],
    farms: [],
  });
  const [loading, setLoading] = useState(true);
  // The payload starts as an empty list, so "has data" means "a response has
  // landed" — an empty answer is still an answer and must not pulse forever.
  const [loaded, setLoaded] = useState(false);
  const skeleton = firstLoad(loading, loaded);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    call<{ tank_mixes: TankMix[]; farms: string[] }>(
      "upande_scp.serverscripts.scouting.scouting_metrics_api.list_tank_mixes",
      {
        farm: farm === ALL_FARMS ? undefined : farm,
        active_only: activeOnly ? 1 : 0,
      },
    )
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setLoaded(true);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [farm, activeOnly]);

  const farms = useMemo(() => data.farms || [], [data]);

  const tree = useMemo(() => buildItemTree(data.tank_mixes), [data.tank_mixes]);
  const visibleMixes = useMemo(
    () => (picked.size ? data.tank_mixes.filter((tm) => matchesPicked(tm, picked)) : data.tank_mixes),
    [data.tank_mixes, picked],
  );

  return (
    <div className="flex flex-col min-h-svh">
      <PageHeader
        title="Tank Mixes"
        eyebrow={
          <>
            Tank mixes ·{" "}
            {skeleton ? <TextSkeleton width="3ch" /> : data.tank_mixes.length} loaded
          </>
        }
      >
          <TreePicker
            label="Items"
            icon={<Layers className="h-3.5 w-3.5" />}
            nodes={tree}
            checked={picked}
            onChange={setPicked}
            disabled={skeleton}
            searchPlaceholder="Search farms and items…"
            emptyHint="No tank mixes to pick from."
          />
          {/* One place pill (place picker G2). `farms` is already scoped
              server-side to what this user may see; one farm reads as itself. */}
          <PlacePicker
            level="farm"
            farms={farms}
            value={{ farm: farm === ALL_FARMS ? "" : farm, greenhouse: "" }}
            onChange={(p) => setFarm(p.farm || ALL_FARMS)}
            disabled={skeleton}
          />
          <Select
            value={activeOnly ? "active" : "all"}
            onValueChange={(v) => setActiveOnly(v === "active")}
          >
            <SelectTrigger aria-label="Status" className={HEADER_PILL}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active only</SelectItem>
              <SelectItem value="all">All mixes</SelectItem>
            </SelectContent>
          </Select>
      </PageHeader>

      <div
        className="flex-1 px-4 md:px-6 py-4 grid grid-cols-1 lg:grid-cols-2 gap-3"
        aria-busy={loading || undefined}
      >
        {skeleton && [0, 1, 2, 3].map((i) => <TankMixCardSkeleton key={i} />)}

        {visibleMixes.length === 0 && !loading && (
          <Card className="p-8 text-center col-span-full">
            <CardTitle className="text-sm">No tank mixes match</CardTitle>
            <CardDescription className="mt-1">
              Try widening the filters.
            </CardDescription>
          </Card>
        )}

        {visibleMixes.map((tm) => (
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
                        No chemicals on this tank mix.
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

/** One tank-mix card before the list lands: the card's own frame (stat labels,
 *  table headings, footer link) with its data slots pulsing. */
function TankMixCardSkeleton() {
  return (
    <Card className="p-4 flex flex-col gap-3" data-skeleton="card">
      <CardHeader className="p-0">
        <div className="flex items-center justify-between gap-3">
          <TextSkeleton width="14rem" />
          <TextSkeleton width="3.5rem" />
        </div>
        <CardDescription>
          <TextSkeleton width="9rem" />
        </CardDescription>
      </CardHeader>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        {["Mix size", "Chemicals", "Water pH", "Hardness"].map((l) => (
          <Stat key={l} label={l} value={<KpiValueSkeleton className="h-5 w-12" />} />
        ))}
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
            <TableRowsSkeleton cols={4} rows={4} />
          </TableBody>
        </Table>
      </CardContent>

      <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground mt-auto">
        <TextSkeleton width="10rem" />
        <span className="inline-flex items-center gap-1">
          <ExternalLink className="h-3 w-3" />
          Open BOM
        </span>
      </div>
    </Card>
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
