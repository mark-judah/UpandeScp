/**
 * Treemap of chemicals in the chemical stores. Area = stock value (the only
 * measure comparable across litres, kilograms and pieces); colour = freshness
 * band. Grouped by farm when more than one farm is in view. Tiles are buttons:
 * Tab to move, Enter/Space to select.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { squarify } from "@/lib/treemap";
import { BAND_ORDER, BAND_STYLE } from "@/lib/stock-freshness";
import type { StockItem } from "@/lib/stock-map";

const FALLBACK_W = 720;
const GROUP_HEAD = 18;
const GAP = 2;

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
}

interface Tile {
  key: string;
  item: StockItem;
  farm: string;
  value: number;
  qty: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface GroupBox {
  farm: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function StockTreemap({
  items,
  farmOf,
  activeCode,
  onHover,
  onSelect,
}: {
  items: StockItem[];
  /** item_code -> farm -> {qty,value} so tiles can be grouped per farm */
  farmOf: Record<string, Record<string, { qty: number; value: number }>>;
  activeCode: string | null;
  onHover: (code: string | null) => void;
  onSelect: (code: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_W);
  const [tip, setTip] = useState<{ x: number; y: number; tile: Tile } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => setTip(null), []);

  const height = Math.round(Math.min(560, Math.max(340, width * 0.6)));

  const { tiles, groups } = useMemo(() => {
    const drawn = items.filter((i) => i.value > 0);
    const farms = new Map<string, { id: string; value: number }>();
    for (const i of drawn)
      for (const [farm, v] of Object.entries(farmOf[i.item_code] ?? {})) {
        if (v.value <= 0) continue;
        const g = farms.get(farm) ?? { id: farm, value: 0 };
        g.value += v.value;
        farms.set(farm, g);
      }
    const multi = farms.size > 1;
    const tiles: Tile[] = [];
    const groups: GroupBox[] = [];
    const byCode = new Map(drawn.map((i) => [i.item_code, i]));
    const lay = (farm: string, box: { x: number; y: number; w: number; h: number }) => {
      const members = drawn
        .map((i) => ({ id: i.item_code, value: farmOf[i.item_code]?.[farm]?.value ?? 0 }))
        .filter((m) => m.value > 0);
      for (const r of squarify(members, box)) {
        const item = byCode.get(r.id)!;
        const fv = farmOf[r.id][farm];
        tiles.push({
          key: `${farm}|${r.id}`, item, farm, value: fv.value, qty: fv.qty,
          x: r.x + GAP / 2, y: r.y + GAP / 2, w: Math.max(0, r.w - GAP), h: Math.max(0, r.h - GAP),
        });
      }
    };
    if (!multi) {
      const farm = [...farms.keys()][0] ?? "";
      lay(farm, { x: 0, y: 0, w: width, h: height });
    } else {
      for (const g of squarify([...farms.values()], { x: 0, y: 0, w: width, h: height })) {
        groups.push({ farm: g.id, x: g.x, y: g.y, w: g.w, h: g.h });
        lay(g.id, { x: g.x, y: g.y + GROUP_HEAD, w: g.w, h: Math.max(0, g.h - GROUP_HEAD) });
      }
    }
    return { tiles, groups };
  }, [items, farmOf, width, height]);

  return (
    <div>
      <div
        ref={ref}
        data-testid="stock-treemap"
        role="group"
        aria-label="Chemicals in stock by value, coloured by freshness"
        className="relative w-full overflow-hidden rounded-[var(--sd-radius)] bg-[var(--sd-bg-soft)]"
        style={{ height }}
        onMouseLeave={() => {
          setTip(null);
          onHover(null);
        }}
      >
        {groups.map((g) => (
          <div
            key={g.farm}
            className="pointer-events-none absolute truncate px-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--sd-muted)]"
            style={{ left: g.x, top: g.y, width: g.w, height: GROUP_HEAD }}
          >
            {g.farm || "No farm"}
          </div>
        ))}
        {tiles.map((t) => {
          const st = BAND_STYLE[t.item.band];
          const big = t.w >= 84 && t.h >= 40;
          const active = activeCode === t.item.item_code;
          const label = `${t.item.item_name}, ${fmt(t.qty)} ${t.item.uom}, value ${fmt(t.value)}, ${st.label}`;
          return (
            <button
              key={t.key}
              type="button"
              data-testid="stock-tile"
              data-code={t.item.item_code}
              data-band={t.item.band}
              aria-label={label}
              aria-pressed={active}
              onClick={() => onSelect(t.item.item_code)}
              onMouseEnter={(e) => {
                onHover(t.item.item_code);
                const box = ref.current?.getBoundingClientRect();
                if (box) setTip({ x: e.clientX - box.left, y: e.clientY - box.top, tile: t });
              }}
              onMouseMove={(e) => {
                const box = ref.current?.getBoundingClientRect();
                if (box) setTip({ x: e.clientX - box.left, y: e.clientY - box.top, tile: t });
              }}
              onFocus={() => onHover(t.item.item_code)}
              onBlur={() => onHover(null)}
              className="absolute overflow-hidden rounded-[4px] border p-1.5 text-left text-[var(--sd-ink)] outline-none transition-[filter,box-shadow] focus-visible:ring-2 focus-visible:ring-[var(--sd-ink)]"
              style={{
                left: t.x, top: t.y, width: t.w, height: t.h,
                background: st.fill,
                borderColor: active ? "var(--sd-ink)" : st.edge,
                boxShadow: active ? "inset 0 0 0 1.5px var(--sd-ink)" : undefined,
                filter: activeCode && !active ? "saturate(0.6) opacity(0.78)" : undefined,
              }}
            >
              {big ? (
                <>
                  <div className="truncate text-[11px] font-semibold leading-tight">{t.item.item_name}</div>
                  <div className="truncate text-[10px] tabular-nums text-[var(--sd-text)]">
                    {fmt(t.qty)} {t.item.uom}
                  </div>
                </>
              ) : null}
            </button>
          );
        })}
        {tip && (
          <div
            role="tooltip"
            data-testid="stock-tooltip"
            className="pointer-events-none absolute z-10 max-w-60 rounded-md border bg-[var(--sd-card)] px-2.5 py-1.5 text-[11px] shadow-md"
            style={{ left: Math.min(tip.x + 12, Math.max(0, width - 220)), top: Math.min(tip.y + 12, height - 56) }}
          >
            <div className="font-semibold text-[var(--sd-ink)]">{tip.tile.item.item_name}</div>
            <div className="tabular-nums text-[var(--sd-text)]">
              {fmt(tip.tile.qty)} {tip.tile.item.uom} · value {fmt(tip.tile.value)}
            </div>
            <div className="text-[var(--sd-muted)]">{BAND_STYLE[tip.tile.item.band].label}</div>
          </div>
        )}
      </div>
      <FreshnessLegend />
    </div>
  );
}

export function FreshnessLegend() {
  return (
    <ul
      data-testid="freshness-legend"
      aria-label="Freshness bands"
      className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--sd-muted)]"
    >
      {BAND_ORDER.map((b) => (
        <li key={b} title={BAND_STYLE[b].rule} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-[3px] border"
            style={{ background: BAND_STYLE[b].fill, borderColor: BAND_STYLE[b].edge }}
          />
          {BAND_STYLE[b].label}
        </li>
      ))}
    </ul>
  );
}
