/** Right-hand panel of the CSU tab: the pinned chemical, or a
 *  page summary when nothing is highlighted. */
import { BAND_STYLE, BAND_ORDER, type FreshnessBand } from "@/lib/stock-freshness";
import type { StockItem } from "@/lib/stock-map";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
}

function BandPill({ band }: { band: FreshnessBand }) {
  const st = BAND_STYLE[band];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium text-[var(--sd-ink)]"
      style={{ background: st.fill, borderColor: st.edge }}
    >
      {st.label}
    </span>
  );
}

function ageText(days: number): string {
  if (days < 1) return "under a day";
  return `${Math.floor(days)} day${Math.floor(days) === 1 ? "" : "s"}`;
}

export function StockSummaryPanel({
  items,
  item,
  unvalued,
}: {
  items: StockItem[];
  item: StockItem | null;
  /** chemicals in stock but without a valuation, so not drawn on the map */
  unvalued: number;
}) {
  if (!item) {
    const counts = BAND_ORDER.map((b) => [b, items.filter((i) => i.band === b).length] as const);
    const total = items.reduce((s, i) => s + i.value, 0);
    return (
      <aside data-testid="stock-summary" aria-label="Stock summary" className="h-[480px] overflow-y-auto rounded-[var(--sd-radius-lg)] border bg-[var(--sd-card)] p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--sd-muted)]">All chemical stores</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-[var(--sd-ink)]">{fmt(total)}</div>
        <div className="text-[11px] text-[var(--sd-muted)]">stock value</div>
        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <dt className="text-[var(--sd-muted)]">Chemicals</dt>
          <dd className="text-right font-medium tabular-nums">{items.length}</dd>
          {counts.map(([b, n]) => (
            <div key={b} className="contents">
              <dt className="text-[var(--sd-muted)]">{BAND_STYLE[b].label}</dt>
              <dd className="text-right font-medium tabular-nums" data-testid={`count-${b}`}>{n}</dd>
            </div>
          ))}
        </dl>
        {unvalued > 0 && (
          <p className="mt-3 text-[11px] text-[var(--sd-muted)]">
            {unvalued} chemical{unvalued === 1 ? "" : "s"} in stock with no valuation are not drawn.
          </p>
        )}
        <p className="mt-3 text-[11px] text-[var(--sd-muted)]">Click a tile (or press Enter on it) to pin where that chemical is and how old it is. Click again or press Esc to unpin.</p>
      </aside>
    );
  }
  const stores = item.locations.filter((l) => l.kind === "store");
  const csus = item.locations.filter((l) => l.kind === "csu");
  return (
    <aside data-testid="stock-summary" aria-label={`${item.item_name} summary`} className="h-[480px] overflow-y-auto rounded-[var(--sd-radius-lg)] border bg-[var(--sd-card)] p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--sd-ink)]">{item.item_name}</div>
          <div className="font-mono text-[10px] text-[var(--sd-muted)]">{item.item_code}</div>
        </div>
        <BandPill band={item.band} />
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums text-[var(--sd-ink)]" data-testid="summary-total">
        {fmt(item.qty)} <span className="text-xs font-normal text-[var(--sd-muted)]">{item.uom}</span>
      </div>
      <div className="text-[11px] text-[var(--sd-muted)]">
        in chemical stores{item.value > 0 ? ` · value ${fmt(item.value)}` : " · no valuation"}
        {item.csuQty > 0 ? ` · ${fmt(item.csuQty)} ${item.uom} more in CSUs` : ""}
      </div>

      <Section title="Where it is">
        {[...stores, ...csus].map((l) => (
          <Row key={`${l.kind}|${l.warehouse}`} left={l.warehouse} sub={l.kind === "csu" ? "CSU" : l.farm || "Store"} right={`${fmt(l.qty)} ${item.uom}`} />
        ))}
      </Section>

      <Section title="Batches">
        {item.batches.length === 0 ? (
          <div className="text-[11px] text-[var(--sd-muted)]">No batch records. Age comes from receipts: oldest stock has been on the shelf {ageText(item.oldestAgeDays)}.</div>
        ) : (
          item.batches.map((b) => (
            <Row
              key={b.batch}
              left={b.batch}
              sub={b.expiry_date ? `expires ${b.expiry_date} (${b.days_to_expiry! < 0 ? `${-b.days_to_expiry!} days ago` : `in ${b.days_to_expiry} days`})` : "no expiry"}
              right={`${fmt(b.qty)} ${item.uom}`}
            />
          ))
        )}
        {item.batches.length > 0 && (
          <div className="pt-1 text-[11px] text-[var(--sd-muted)]">Oldest stock on the shelf: {ageText(item.oldestAgeDays)}.</div>
        )}
      </Section>
      <p className="mt-3 text-[10px] text-[var(--sd-muted)]">{BAND_STYLE[item.band].label}: {BAND_STYLE[item.band].rule}.</p>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--sd-muted)]">{title}</h3>
      <div className="divide-y divide-[var(--sd-line)]">{children}</div>
    </section>
  );
}

function Row({ left, sub, right }: { left: string; sub: string; right: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-xs">
      <div className="min-w-0">
        <div className="truncate font-medium">{left}</div>
        <div className="truncate text-[10px] text-[var(--sd-muted)]">{sub}</div>
      </div>
      <div className="shrink-0 tabular-nums">{right}</div>
    </div>
  );
}
