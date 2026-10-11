/**
 * A person against the farm median, and up to two others, on one set of axes.
 * Read-only. Ported in shape from Livestock's CompareDialog: the median is a
 * dashed outline (a reference, not a competitor), people are filled shapes.
 */
import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { point, type RadarAxis } from "@/components/people/KpiRadar";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { cn } from "@/lib/utils";

const SIZE = 320;
const C = SIZE / 2;
const R = 112;
const RINGS = 4;
const LABEL_PAD = 50;
const MAX = 3;
const LINES = ["var(--sd-ink)", "var(--sd-data-cyan)", "var(--sd-data-amber)"];

export interface ComparePerson {
  id: string;
  name: string;
  sub?: string;
  image?: string | null;
}

function polygon(values: (number | null)[], n: number) {
  return values
    .map((v, i) => {
      const p = point(i, n, R * Math.max(0, Math.min(1, v ?? 0)), C);
      return `${p.x},${p.y}`;
    })
    .join(" ");
}

export function CompareDialog({
  open,
  onOpenChange,
  subject,
  pool,
  axesFor,
  benchmark,
  benchmarkReadouts,
  benchmarkLabel = "Farm median",
  direction = "Outward is better on every axis.",
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  subject: ComparePerson;
  /** everyone else who may be added */
  pool: ComparePerson[];
  axesFor: (id: string) => RadarAxis[];
  /** 0–1 per axis, same order */
  benchmark: (number | null)[];
  benchmarkReadouts: string[];
  benchmarkLabel?: string;
  direction?: string;
}) {
  const [others, setOthers] = useState<ComparePerson[]>([]);
  const [term, setTerm] = useState("");
  const cohort = [subject, ...others].slice(0, MAX);
  const axes = cohort.map((p) => axesFor(p.id));
  const labels = axes[0] ?? [];
  const n = labels.length;

  const choices = useMemo(() => {
    const taken = new Set(cohort.map((p) => p.id));
    const q = term.trim().toLowerCase();
    return pool
      .filter((p) => !taken.has(p.id))
      .filter((p) => !q || [p.id, p.name, p.sub || ""].some((f) => f.toLowerCase().includes(q)))
      .slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, term, others, subject.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94vh] w-[min(1100px,96vw)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>How {subject.name} compares</DialogTitle>
          <DialogDescription>
            Against the {benchmarkLabel.toLowerCase()}, and up to two others. {direction}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-7 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <svg
              viewBox={`${-LABEL_PAD} 0 ${SIZE + LABEL_PAD * 2} ${SIZE}`}
              className="w-full"
              role="img"
              aria-label="Comparison"
            >
              {Array.from({ length: RINGS }, (_, r) => (
                <polygon
                  key={r}
                  points={Array.from({ length: n }, (_, i) => {
                    const p = point(i, n, (R * (r + 1)) / RINGS, C);
                    return `${p.x},${p.y}`;
                  }).join(" ")}
                  fill="none"
                  stroke="var(--sd-line-soft)"
                />
              ))}
              {Array.from({ length: n }, (_, i) => {
                const p = point(i, n, R, C);
                return <line key={i} x1={C} y1={C} x2={p.x} y2={p.y} stroke="var(--sd-line-soft)" />;
              })}
              <polygon
                points={polygon(benchmark.slice(0, n), n)}
                fill="none"
                stroke="var(--sd-quiet)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
              {cohort.map((p, ci) => (
                <polygon
                  key={p.id}
                  points={polygon(axes[ci].map((x) => x.value), n)}
                  fill={LINES[ci]}
                  fillOpacity={ci === 0 ? 0.12 : 0.07}
                  stroke={LINES[ci]}
                  strokeWidth={ci === 0 ? 2 : 1.5}
                  strokeLinejoin="round"
                />
              ))}
              {labels.map((a, i) => {
                const p = point(i, n, R + 22, C);
                return (
                  <text
                    key={a.key}
                    x={p.x}
                    y={p.y}
                    textAnchor={p.x > C + 4 ? "start" : p.x < C - 4 ? "end" : "middle"}
                    dominantBaseline="middle"
                    className="fill-[var(--sd-quiet)] text-[9.5px] font-medium uppercase"
                    style={{ letterSpacing: "0.1em" }}
                  >
                    {a.label}
                  </text>
                );
              })}
            </svg>
            <ul className="flex flex-col gap-1.5">
              {cohort.map((p, ci) => (
                <li key={p.id} className="flex items-center gap-2.5 text-[12.5px]">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: LINES[ci] }} />
                  <span className="font-medium text-[var(--sd-ink)]">{p.name}</span>
                  <span className="tabular-nums text-[var(--sd-quiet)]">{p.id}</span>
                  {ci > 0 && (
                    <button
                      type="button"
                      onClick={() => setOthers((o) => o.filter((x) => x.id !== p.id))}
                      className="ml-auto text-[var(--sd-quiet)] hover:text-[var(--sd-ink)]"
                      aria-label={`Remove ${p.name} from the comparison`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
              <li className="flex items-center gap-2.5 text-[12.5px] text-[var(--sd-muted)]">
                <svg width="12" height="4" aria-hidden>
                  <line x1="0" y1="2" x2="12" y2="2" stroke="var(--sd-quiet)" strokeWidth="2" strokeDasharray="3 2" />
                </svg>
                {benchmarkLabel}
              </li>
            </ul>
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <table className="w-full border-collapse text-[13px]" aria-label="Comparison figures">
              <thead>
                <tr className="border-b border-[var(--sd-line)] text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sd-quiet)]">
                  <th className="py-2 pr-3">Measure</th>
                  {cohort.map((p) => (
                    <th key={p.id} className="py-2 pr-3 text-right">{p.name}</th>
                  ))}
                  <th className="py-2 text-right">{benchmarkLabel}</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((axis, i) => (
                  <tr key={axis.key} className="border-b border-[var(--sd-line-soft)] last:border-0">
                    <td className="py-2 pr-3 text-[var(--sd-muted)]">{axis.label}</td>
                    {cohort.map((p, ci) => {
                      const cell = axes[ci][i];
                      const under = cell.value != null && benchmark[i] != null && cell.value < (benchmark[i] as number);
                      return (
                        <td
                          key={p.id}
                          className={cn(
                            "py-2 pr-3 text-right tabular-nums",
                            under ? "text-[var(--sd-sev-critical)]" : "text-[var(--sd-ink)]",
                          )}
                        >
                          {cell.readout}
                        </td>
                      );
                    })}
                    <td className="py-2 text-right tabular-nums text-[var(--sd-quiet)]">{benchmarkReadouts[i] ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {others.length < MAX - 1 && pool.length > 0 && (
              <div className="flex flex-col gap-2">
                <label className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--sd-quiet)]">
                  Add another
                </label>
                <Input
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  placeholder="Name or ID…"
                  aria-label="Add another to compare"
                  className="h-9 text-[13px]"
                />
                <div className="flex flex-wrap gap-1.5">
                  {choices.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setOthers((o) => [...o, p]);
                        setTerm("");
                      }}
                      className="inline-flex items-center gap-1.5 rounded-[var(--sd-radius-pill)] bg-[var(--sd-bg-soft)] px-2.5 py-1 text-[12px] text-[var(--sd-ink)] transition-colors hover:bg-[var(--sd-pistachio)]"
                    >
                      <PersonAvatar id={p.id} name={p.name} image={p.image} size={16} />
                      {p.name}
                      <Plus className="h-3 w-3 text-[var(--sd-quiet)]" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
