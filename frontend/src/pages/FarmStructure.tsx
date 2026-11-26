/**
 * Farm structure (#/<crop>/structure): how a farm's nodes connect, drawn two
 * ways. "Paths" lists each distinct chain of node types (Farm → Phase → Section
 * → Block → Hexa → Triad) with the stations on it; "Tree" is a collapsible
 * left-to-right mind map of the real nodes. Levels above the station are free
 * per branch, which is why the chains can differ inside one farm.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { PlacePicker } from "@/components/PlacePicker";
import { TogglePill } from "@/components/TogglePill";
import { SearchInput } from "@/components/SearchInput";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import { Bar, LoadProgress } from "@/components/Loading";
import { useToast } from "@/components/Toast";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { createLatest } from "@/lib/latest-only";
import { readPlace, type Place } from "@/lib/places";
import {
  fetchFarmStructure, setNodeCrop, type FarmStructure, type StructureNode, type StructurePath,
} from "@/lib/structure-api";
import { CropBadge, NodeCropEditor } from "@/components/NodeCrop";
import {
  defaultExpanded, findPath, layoutTree, unitText,
} from "@/lib/structure-tree";

type Tab = "paths" | "tree";

const NODE_W = 214;
const NODE_H = 70;
const PAD = 16;
const NUM = { fontVariantNumeric: "tabular-nums" } as const;
const FONT = "Poppins, system-ui, sans-serif";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function PathRow({ path }: { path: StructurePath }) {
  const chips = path.types.map((t) => ({ t, w: Math.max(54, t.length * 7.4 + 24) }));
  const GAP = 26;
  const total = chips.reduce((a, c) => a + c.w, 0) + GAP * (chips.length - 1);
  let x = 0;
  return (
    <div className="rounded-[var(--sd-radius)] bg-card p-4 shadow-[var(--sd-shadow-1)]">
      <div className="overflow-x-auto">
        <svg width={total + 2} height={40} role="img" aria-label={path.types.join(" to ")}>
          {chips.map((c, i) => {
            const left = x;
            x += c.w + GAP;
            return (
              <g key={`${c.t}-${i}`}>
                {i > 0 && (
                  <g stroke="var(--sd-quiet)" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <path d={`M${left - GAP + 4} 20 H${left - 5}`} />
                    <path d={`M${left - 9} 16 L${left - 5} 20 L${left - 9} 24`} />
                  </g>
                )}
                <rect x={left} y={6} width={c.w} height={28} rx={14} fill="var(--sd-bg-soft)" />
                <text x={left + c.w / 2} y={24} textAnchor="middle" fontSize={12} fontWeight={500}
                  fontFamily={FONT} fill="var(--sd-text)">{c.t}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-1 text-xs text-muted-foreground" style={NUM}>
        {path.stations.toLocaleString()} {path.stations === 1 ? "station" : "stations"}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-[var(--sd-radius)] bg-card p-4 shadow-[var(--sd-shadow-1)]">
          <Bar className="h-7 w-2/3" />
          <Bar className="mt-3 h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

function TreeView({
  data, expanded, setExpanded, hit, onEditCrop,
}: {
  data: FarmStructure;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  hit: string;
  onEditCrop?: (node: StructureNode) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const { nodes, links } = useMemo(
    () => (data.root ? layoutTree(data.root, expanded) : { nodes: [], links: [] }),
    [data.root, expanded],
  );
  const at = useMemo(() => new Map(nodes.map((n) => [n.node.name, n])), [nodes]);
  const width = (nodes.length ? Math.max(...nodes.map((n) => n.x)) : 0) + NODE_W + PAD * 2;
  const height = (nodes.length ? Math.max(...nodes.map((n) => n.y)) : 0) + NODE_H + PAD * 2;

  useEffect(() => {
    const target = hit ? at.get(hit) : undefined;
    const box = wrap.current;
    if (!target || !box) return;
    box.scrollTo({
      left: Math.max(0, target.x - box.clientWidth / 3),
      top: Math.max(0, target.y - box.clientHeight / 2),
      behavior: "smooth",
    });
  }, [hit, at]);

  const toggle = (name: string) => {
    const next = new Set(expanded);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpanded(next);
  };

  return (
    <div ref={wrap} className="max-h-[calc(100svh-15rem)] min-h-[20rem] overflow-auto rounded-[var(--sd-radius)] bg-card shadow-[var(--sd-shadow-1)]">
      <svg width={width} height={height} role="tree" aria-label={`${data.farm} structure`}>
        <g transform={`translate(${PAD} ${PAD})`}>
          {links.map((l) => {
            const a = at.get(l.from)!;
            const b = at.get(l.to)!;
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path key={`${l.from}>${l.to}`} d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`}
                fill="none" stroke="var(--sd-quiet)" strokeOpacity={0.55} strokeWidth={1.4} />
            );
          })}
          {nodes.map(({ node, x, y }) => {
            const has = node.children.length > 0;
            const open = expanded.has(node.name);
            const hot = node.name === hit;
            return (
              <g key={node.name} transform={`translate(${x} ${y})`} role="treeitem"
                aria-expanded={has ? open : undefined}
                style={{ cursor: has ? "pointer" : "default" }}
                onClick={() => has && toggle(node.name)}>
                <rect width={NODE_W} height={NODE_H} rx={10} fill="var(--sd-bg-soft)"
                  stroke={hot ? "var(--sd-text)" : "none"} strokeWidth={hot ? 1.5 : 0} />
                <text x={12} y={18} fontSize={12.5} fontWeight={600} fontFamily={FONT} fill="var(--sd-text)">
                  {clip(node.label, 24)}
                </text>
                <text x={12} y={33} fontSize={10.5} fontFamily={FONT} fill="var(--sd-quiet)" style={NUM}>
                  {clip(node.unit ? unitText(node.unit) : node.type, 34)}
                </text>
                {node.flags.slice(0, 2).map((f, i) => {
                  const w = f.length * 5.6 + 14;
                  const fx = 12 + (i ? node.flags[0].length * 5.6 + 20 : 0);
                  return (
                    <g key={f}>
                      <rect x={fx} y={38} width={w} height={13} rx={6.5} fill="var(--sd-alert-warn)" />
                      <text x={fx + w / 2} y={47.5} textAnchor="middle" fontSize={9} fontWeight={500}
                        fontFamily={FONT} fill="var(--sd-sev-high)">{f}</text>
                    </g>
                  );
                })}
                <CropBadge crop={node.crop} x={12} y={53} maxWidth={NODE_W - 24}
                  editable={!!onEditCrop} onEdit={() => onEditCrop?.(node)} />
                {has && (
                  <text x={NODE_W - 12} y={18} textAnchor="end" fontSize={10.5} fontFamily={FONT}
                    fill="var(--sd-quiet)" style={NUM}>
                    {open ? "−" : `+${node.children.length}`}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export function FarmStructure({ initialCrop = "" }: { initialCrop?: string }) {
  const toast = useToast();
  const { farms, loading: farmsLoading } = useCropFarms(initialCrop);
  const farmNames = useMemo(() => Object.keys(farms).sort(), [farms]);
  const [place, setPlace] = useState<Place>(() => readPlace(initialCrop) ?? { farm: "", greenhouse: "" });
  const [tab, setTab] = useState<Tab>("paths");
  const [data, setData] = useState<FarmStructure | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [hit, setHit] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<StructureNode | null>(null);
  const [saving, setSaving] = useState(false);
  const latest = useRef(createLatest());

  // Default to the first farm once the list is in and nothing valid is picked.
  const farm = farmNames.includes(place.farm) ? place.farm : farmNames[0] ?? "";

  const load = useCallback(
    (refresh: boolean, keepView = false) => {
      if (!farm) return;
      const current = latest.current.start();
      setLoading(true);
      setError("");
      fetchFarmStructure(farm, refresh)
        .then((d) => {
          if (!current()) return;
          setData(d);
          if (!keepView) {
            setExpanded(d.root ? defaultExpanded(d.root) : new Set());
            setSearch("");
            setHit("");
          }
        })
        .catch((e) => {
          if (!current()) return;
          const msg = String(e?.message ?? e);
          setError(msg);
          toast.show("Could not load the farm structure.", "err", { hint: msg });
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    },
    [farm, toast],
  );

  useEffect(() => {
    setData(null);
    load(false);
  }, [load]);

  useEffect(() => {
    if (!data?.root) return;
    const path = findPath(data.root, search);
    if (!path.length) {
      setHit("");
      return;
    }
    setExpanded((prev) => new Set([...prev, ...path.slice(0, -1)]));
    setHit(path[path.length - 1]);
  }, [search, data]);

  const saveCrop = (crop: string | null) => {
    if (!editing) return;
    setSaving(true);
    setNodeCrop(editing.name, crop)
      .then(() => {
        toast.show(crop ? `${editing.label} set to ${crop}.` : `Crop cleared on ${editing.label}.`, "ok");
        setEditing(null);
        load(true, true);
      })
      .catch((e) => toast.show("Could not save the crop.", "err", { hint: String(e?.message ?? e) }))
      .finally(() => setSaving(false));
  };

  const first = loading && !data;
  const empty = !!data && (tab === "paths" ? data.paths.length === 0 : !data.root);

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader
        eyebrow="Settings · Layout"
        title="Farm structure"
        tab={tab}
        switcher={
          <div className="flex items-center gap-2">
            <TogglePill pressed={tab === "paths"} onPressedChange={() => setTab("paths")}>Paths</TogglePill>
            <TogglePill pressed={tab === "tree"} onPressedChange={() => setTab("tree")}>Tree</TogglePill>
          </div>
        }
        filters={[
          {
            key: "farm",
            node: (
              <PlacePicker farms={farmNames} value={{ farm, greenhouse: "" }} onChange={setPlace}
                level="farm" crop={initialCrop} allLabel={false} label="Farm"
                disabled={farmsLoading && farmNames.length === 0} />
            ),
          },
          ...(data?.triad_side_m
            ? [{
                key: "triad-side",
                node: (
                  <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground tabular-nums">
                    Triangle side {data.triad_side_m} m
                  </span>
                ),
              }]
            : []),
          {
            key: "search", tabs: ["tree"],
            node: <SearchInput size="md" className="w-56" value={search} onChange={setSearch} placeholder="Find a node" />,
          },
        ]}
      >
        <HeaderIconButton aria-label="Refresh" tooltip="Rebuild this farm's structure" onClick={() => load(true)}>
          <RefreshCw className="h-4 w-4" />
        </HeaderIconButton>
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress active={loading && !!data} />
        {error && !loading ? (
          <div className="flex items-center gap-3 rounded-[var(--sd-radius)] bg-[var(--sd-alert-error)] p-4 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--sd-sev-critical)" }} aria-hidden />
            <span className="min-w-0 flex-1">Could not load the farm structure. {error}</span>
            <button type="button" onClick={() => load(false)}
              className={`${HEADER_PILL} inline-flex cursor-pointer items-center justify-center`}>Retry</button>
          </div>
        ) : null}
        {first || (farmsLoading && !data && !error) ? (
          <Skeleton />
        ) : empty ? (
          <p className="text-sm text-muted-foreground">This farm has no structure to draw yet.</p>
        ) : data && tab === "paths" ? (
          <div className="flex flex-col gap-3">
            {data.paths.map((p) => <PathRow key={p.types.join(">")} path={p} />)}
          </div>
        ) : data ? (
          <>
            {editing && data.can_edit && (
              <NodeCropEditor label={editing.label} current={editing.crop?.own ?? null}
                crops={data.crops ?? []} saving={saving} onSave={saveCrop} onClose={() => setEditing(null)} />
            )}
            <TreeView data={data} expanded={expanded} setExpanded={setExpanded} hit={hit}
              onEditCrop={data.can_edit ? setEditing : undefined} />
          </>
        ) : null}
      </div>
    </div>
  );
}
