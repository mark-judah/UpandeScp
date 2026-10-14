/**
 * What the person has done, newest first, grouped (by month, by week …).
 * Ported in shape from Livestock's EventFeed.
 */
import type { LucideIcon } from "lucide-react";

export interface FeedItem {
  key: string;
  /** the group heading this item falls under */
  group: string;
  label: string;
  detail?: string;
  /** right-hand date or figure */
  aside?: string;
  icon: LucideIcon;
  tone?: string;
}

export function ActivityFeed({ items, empty }: { items: FeedItem[]; empty: string }) {
  if (!items.length) return <p className="text-[13px] text-[var(--sd-muted)]">{empty}</p>;
  const groups = new Map<string, FeedItem[]>();
  for (const it of items) {
    if (!groups.has(it.group)) groups.set(it.group, []);
    groups.get(it.group)!.push(it);
  }
  return (
    <div className="flex flex-col gap-5">
      {[...groups.entries()].map(([group, rows]) => (
        <section key={group} className="flex flex-col gap-1">
          <div className="flex items-center gap-3 pb-1">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sd-quiet)]">{group}</h3>
            <span className="h-px flex-1 bg-[var(--sd-line-soft)]" />
            <span className="text-[11px] tabular-nums text-[var(--sd-quiet)]">{rows.length}</span>
          </div>
          <ol className="flex flex-col">
            {rows.map((m) => {
              const Icon = m.icon;
              const tone = m.tone || "var(--sd-muted)";
              return (
                <li
                  key={m.key}
                  className="flex items-start gap-3 rounded-[var(--sd-radius)] px-2 py-2.5 transition-colors hover:bg-[var(--sd-bg-soft)]"
                >
                  <span
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                    style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
                  >
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} style={{ color: tone }} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13.5px] font-medium text-[var(--sd-ink)]">{m.label}</span>
                    {m.detail && <span className="text-[12px] text-[var(--sd-muted)]">{m.detail}</span>}
                  </span>
                  {m.aside && (
                    <span className="shrink-0 pt-0.5 text-[11.5px] tabular-nums text-[var(--sd-quiet)]">{m.aside}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function ActivityFeedSkeleton({ rows = 5 }: { rows?: number }) {
  const widths = ["78%", "56%", "70%", "48%", "66%"];
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-[var(--sd-bg-soft)]" />
          <div className="h-[13px] animate-pulse rounded bg-[var(--sd-bg-soft)]" style={{ width: widths[i % 5] }} />
        </div>
      ))}
    </div>
  );
}
