import { formatCapture } from "@/lib/capture-time";
import { recordedLines, type Station } from "@/lib/scouting-stations";

/** What a scout recorded at a station: who, when, the pests / diseases, entry links. */
export function StationCardBody({
  station,
  scoutName,
  color,
  summary = false,
}: {
  station: Station;
  scoutName: string;
  color: string;
  /** Rows from a server summary: only who and when are known, not what was recorded. */
  summary?: boolean;
}) {
  const pests = recordedLines(station.pests);
  const diseases = recordedLines(station.diseases);
  const when = formatCapture(`${station.date} ${summary ? "" : station.time}`.trim());
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 bg-white px-1 text-[0.65rem] font-semibold tabular-nums"
          style={{ borderColor: color }}
          title={`Stop ${station.order} of ${station.walkSize}`}
        >
          {summary ? "•" : station.order}
        </span>
        <span className="font-medium">{scoutName}</span>
        {summary ? null : (
          <span className="text-muted-foreground">
            stop {station.order} of {station.walkSize}
          </span>
        )}
      </div>
      <div className="text-muted-foreground">
        {when}
        {station.place ? ` · ${station.place}` : ""}
        {station.source === "gps" ? " · placed by the scout's GPS" : ""}
      </div>
      {(summary ? [] : ([["Pests", pests], ["Diseases", diseases]] as const)).map(([title, rows]) => (
        <div key={title}>
          <div className="mb-1 text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
          {rows.length ? (
            rows.map(([name, n]) => (
              <div key={name} className="mb-1 flex items-center gap-2 rounded bg-[var(--sd-bg-soft)] px-2 py-1">
                <span className="flex-1 truncate">{name}</span>
                <span className="tabular-nums text-muted-foreground">{n}</span>
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">None recorded</span>
          )}
        </div>
      ))}
      {summary ? (
        <div className="text-muted-foreground">Latest visit on this unit in the range.</div>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {(summary ? [] : station.entries).slice(0, 4).map((n) => (
          <a
            key={n}
            className="underline underline-offset-2"
            href={`/app/scouting-entry/${encodeURIComponent(n)}`}
            target="_blank"
            rel="noreferrer"
          >
            Open entry {n}
          </a>
        ))}
        {!summary && station.entries.length > 4 ? (
          <span className="text-muted-foreground">+{station.entries.length - 4} more</span>
        ) : null}
      </div>
    </div>
  );
}
