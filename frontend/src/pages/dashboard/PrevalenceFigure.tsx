import { cn } from "@/lib/utils";
import {
  figureLine,
  figureTooltip,
  mixLabel,
  reliabilityMix,
  type PrevalenceFigures,
  type Reliability,
} from "@/lib/prevalence";

const TONE: Record<Reliability, string> = {
  Good: "var(--sd-data-green)",
  Fair: "var(--sd-data-amber)",
  Low: "var(--sd-muted)",
};

/** Good / Fair / Low as a small tinted pill — colour on text and background,
 *  never a border strip. */
export function ReliabilityPill({ value }: { value: Reliability }) {
  const tone = TONE[value] ?? TONE.Low;
  return (
    <span
      data-testid="reliability-pill"
      className="inline-flex items-center rounded-full px-1.5 py-px text-[0.6rem] font-medium leading-none"
      style={{ color: tone, background: `color-mix(in srgb, ${tone} 14%, transparent)` }}
    >
      {value}
    </span>
  );
}

/** "Good 64 · Fair 28 · Low 3" — each rating in its own tone, as text. */
export function ReliabilityMix({ parts }: { parts: { rating: Reliability; count: number }[] }) {
  return (
    <span data-testid="reliability-mix" aria-label={`Houses by reliability: ${mixLabel(parts)}`} className="whitespace-nowrap text-[0.6rem] font-medium">
      {parts.map((p, i) => (
        <span key={p.rating}>
          {i > 0 && <span className="text-muted-foreground"> · </span>}
          <span style={{ color: TONE[p.rating] }}>
            {p.rating} {p.count}
          </span>
        </span>
      ))}
    </span>
  );
}

/** `34% (was 50%) · ±6 · 8/9` + reliability pill (one house) or the houses'
 *  reliability share (a scope); hover explains the figures. */
export function PrevalenceFigure({
  fig,
  className,
}: {
  fig: PrevalenceFigures | null | undefined;
  className?: string;
}) {
  if (!fig) return null;
  const mix = reliabilityMix(fig);
  return (
    <div
      data-testid="prevalence-figure"
      title={figureTooltip(fig)}
      className={cn(
        "flex items-center gap-1.5 text-[0.7rem] text-muted-foreground tabular-nums",
        className,
      )}
    >
      <span className="truncate">{figureLine(fig)}</span>
      {mix ? <ReliabilityMix parts={mix} /> : <ReliabilityPill value={fig.reliability} />}
    </div>
  );
}
