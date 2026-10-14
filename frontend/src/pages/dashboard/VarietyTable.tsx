import { cn } from "@/lib/utils";
import { VARIETY_MIN_N, type VarietyRow } from "@/lib/prevalence";

/** Stage & variety S7: the selected pest by rose variety — a station's variety
 *  is the variety of the bed it was scouted on, each house's latest scouted
 *  week. Hidden when nothing carries a variety (avocado, coffee). A variety
 *  with fewer than VARIETY_MIN_N scouted stations is greyed "too few". */
export function VarietyTable({
  rows,
  pest,
  titled = false,
}: {
  rows: VarietyRow[] | null | undefined;
  pest?: string;
  /** the surrounding card already titles the table: hide the inner label */
  titled?: boolean;
}) {
  if (!rows?.length) return null;
  const withSigns = rows.some((r) => r.signs != null);
  const pct = (v: number | null) => (v == null ? "—" : `${v}%`);
  return (
    <div data-testid="variety-table" className="flex flex-col gap-1">
      {!titled && (
        <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
          {pest ? `By variety · ${pest}` : "By variety"}
        </div>
      )}
      <table className="w-full text-[0.7rem] tabular-nums">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-0.5 font-medium">Variety</th>
            <th className="py-0.5 text-right font-medium">Beds</th>
            <th className="py-0.5 text-right font-medium">Stations</th>
            <th className="py-0.5 text-right font-medium">Live</th>
            {withSigns && <th className="py-0.5 text-right font-medium">Signs</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.variety || "__none"}
              data-testid="variety-row"
              data-few={r.few ? "true" : "false"}
              title={r.few ? `Fewer than ${VARIETY_MIN_N} stations scouted: too few to read much into` : undefined}
              className={cn("border-t border-[var(--sd-line)]", r.few && "text-muted-foreground opacity-60")}
            >
              <td className="max-w-40 truncate py-0.5" title={r.variety || "No variety recorded"}>
                {r.variety || "No variety recorded"}
                {r.few && <span className="ml-1 text-[0.6rem]">too few</span>}
              </td>
              <td className="py-0.5 text-right">{r.beds}</td>
              <td className="py-0.5 text-right">{r.scouted}</td>
              <td className="py-0.5 text-right">{pct(r.prevalence)}</td>
              {withSigns && <td className="py-0.5 text-right">{pct(r.signs)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
