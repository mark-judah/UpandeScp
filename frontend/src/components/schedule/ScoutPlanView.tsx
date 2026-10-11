/**
 * The weekly scout plan (spec C4–C6): a Mon–Sun grid for one farm, greenhouse rows
 * (or scout rows), each cell holding the planned scouts as avatar chips.
 *
 * * Assign: pick a scout in the side list, then click a cell — or drag the scout
 *   onto it. Clicking a chip removes it. In scout rows, pick a greenhouse instead.
 * * Leave: a scout on approved leave that day is greyed in the list and cannot be
 *   dropped there; pending leave only warns.
 * * Past days show Done / Missed; scouting nobody planned is a faint outlined chip.
 * * Edits stay local until Save, which replaces the farm's week on the server.
 *   Only users who manage the farm see the editing controls.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { addWeeks, format, startOfWeek } from "date-fns";
import { Check, ChevronLeft, ChevronRight, Copy, Eraser, Save, Undo2, X } from "lucide-react";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import {
  fetchScoutPlan,
  saveScoutPlan,
  type PlanActual,
  type PlanRow,
  type ScoutPlan,
} from "@/lib/scout-plan-api";
import { cn } from "@/lib/utils";
import { ASSIGNMENT_COLORS, paint } from "./schedule-colors";
import { day, shortGreenhouse } from "./schedule-utils";
import {
  addAssignment,
  copyLastWeek,
  leaveNote,
  removeAssignment,
  rowKey,
  statusFor,
  unplannedActuals,
  weeklyCheck,
} from "./scout-plan-utils";

export type ScoutRowsBy = "greenhouse" | "scout";

const ymd = (d: Date) => format(d, "yyyy-MM-dd");
export const mondayOf = (s: string) => ymd(startOfWeek(day(s), { weekStartsOn: 1 }));
const firstName = (n: string) => (n || "").split(/\s+/)[0] || n;
const selectCls = "h-9 rounded-md border border-input bg-background px-2 text-sm min-w-0 max-w-full";

export function ScoutPlanView({
  crop,
  initialFarm,
  initialWeek,
}: {
  crop?: string;
  initialFarm?: string;
  /** any day of the week to open on */
  initialWeek: string;
}) {
  const [week, setWeek] = useState(() => mondayOf(initialWeek));
  const [farm, setFarm] = useState(initialFarm || "");
  const [data, setData] = useState<ScoutPlan | null>(null);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [rowsBy, setRowsBy] = useState<ScoutRowsBy>("greenhouse");
  const [armed, setArmed] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "error" | "warn" | "ok"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const adopt = useCallback((p: ScoutPlan) => {
    setData(p);
    setRows(p.assignments.map((a) => ({ date: a.date, scout: a.scout, greenhouse: a.greenhouse })));
    setDirty(false);
  }, []);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    fetchScoutPlan({ crop, farm, week_start: week })
      .then((p) => {
        if (id === requestId.current) adopt(p);
      })
      .catch((e) => {
        if (id !== requestId.current) return;
        setData(null);
        setError(errorText(e));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [crop, farm, week, adopt]);

  useEffect(() => {
    load();
  }, [load]);

  const scouts = useMemo(() => new Map((data?.scouts || []).map((s) => [s.scout, s])), [data]);
  const nameOf = (id: string) => scouts.get(id)?.name || id;
  const canEdit = !!data?.canEdit;
  const days = data?.days || [];
  const today = data?.today || ymd(new Date());
  const pickDay = focusDay && days.includes(focusDay) ? focusDay : days.includes(today) ? today : days[0];
  const leaves = data?.leaves || {};

  const check = useMemo(
    () => (data ? weeklyCheck(data.greenhouses, rows, data.elsewhere, data.farm, data.leaves) : null),
    [data, rows],
  );
  const unplanned = useMemo(() => unplannedActuals(data?.actuals || [], rows), [data, rows]);
  const tally = useMemo(() => {
    const t = { Done: 0, Missed: 0, Planned: 0, "On leave": 0 };
    for (const r of rows) t[statusFor(r, data?.actuals || [], today, data?.leaves)]++;
    return t;
  }, [rows, data, today]);

  const edit = (next: PlanRow[]) => {
    setRows(next);
    setDirty(true);
  };

  const assign = (row: PlanRow) => {
    if (!canEdit) return;
    const res = addAssignment(rows, row, leaves, nameOf(row.scout));
    if (res.error) {
      setNote({ tone: "error", text: res.error });
      return;
    }
    if (res.rows !== rows) edit(res.rows);
    setNote(res.warning ? { tone: "warn", text: res.warning } : null);
  };

  const cellTarget = (rowId: string, date: string): PlanRow | null => {
    if (!armed) return null;
    return rowsBy === "greenhouse"
      ? { date, scout: armed, greenhouse: rowId }
      : { date, scout: rowId, greenhouse: armed };
  };

  const blocked = (rowId: string, date: string) => {
    const scout = rowsBy === "greenhouse" ? armed : rowId;
    return !!scout && leaves[scout]?.[date] === "on_leave";
  };

  const onDrop = (e: DragEvent, rowId: string, date: string) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    assign(rowsBy === "greenhouse" ? { date, scout: id, greenhouse: rowId } : { date, scout: rowId, greenhouse: id });
  };

  const copy = () => {
    if (!data) return;
    const { rows: copied, source, skippedLeave } = copyLastWeek(data);
    edit(copied);
    setNote({
      tone: copied.length ? "ok" : "warn",
      text: copied.length
        ? `Copied ${copied.length} assignment${copied.length === 1 ? "" : "s"} from last week's ${source === "plan" ? "plan" : "actual scouting"}${skippedLeave ? ` (${skippedLeave} skipped: approved leave)` : ""}.`
        : "Nothing to copy from last week.",
    });
  };

  const save = () => {
    if (!data) return;
    setSaving(true);
    saveScoutPlan({ crop, farm: data.farm, week_start: data.weekStart, assignments: rows })
      .then((p) => {
        adopt(p);
        setNote(
          p.warnings?.length
            ? { tone: "warn", text: `Saved ${p.saved}. ${p.warnings.join(" ")}` }
            : { tone: "ok", text: `Saved ${p.saved ?? rows.length} assignment${rows.length === 1 ? "" : "s"}.` },
        );
      })
      .catch((e) => setNote({ tone: "error", text: errorText(e) }))
      .finally(() => setSaving(false));
  };

  const step = (dir: 1 | -1) => {
    if (dirty && !window.confirm("Discard unsaved changes to this week?")) return;
    setWeek((w) => ymd(addWeeks(day(w), dir)));
  };

  // ── the grid ──
  const gridRows =
    rowsBy === "greenhouse"
      ? (data?.greenhouses || []).map((h) => ({ id: h, label: shortGreenhouse(h, data?.farm) }))
      : [...new Set([...(data?.scouts || []).map((s) => s.scout), ...rows.map((r) => r.scout)])]
          .map((s) => ({ id: s, label: nameOf(s) }))
          .sort((a, b) => a.label.localeCompare(b.label));
  const cols = `minmax(120px, 160px) repeat(7, minmax(92px, 1fr))`;

  const inCell = (rowId: string, date: string) =>
    rows.filter((r) => r.date === date && (rowsBy === "greenhouse" ? r.greenhouse === rowId : r.scout === rowId));
  const ghostsIn = (rowId: string, date: string): PlanActual[] =>
    unplanned.filter((a) => a.date === date && (rowsBy === "greenhouse" ? a.greenhouse === rowId : a.scout === rowId));

  const pickerItems =
    rowsBy === "greenhouse"
      ? (data?.scouts || []).map((s) => ({
          id: s.scout,
          label: s.name,
          image: s.image,
          leave: leaves[s.scout]?.[pickDay],
          sub: `${s.entries} entries · 4 wks`,
          leaveNote: leaveNote(days, leaves[s.scout]),
        }))
      : (data?.greenhouses || []).map((h) => ({
          id: h,
          label: shortGreenhouse(h, data?.farm),
          image: undefined as string | undefined,
          leave: undefined,
          sub: "",
          leaveNote: "",
        }));

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="scout-plan">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Previous week" onClick={() => step(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium tabular-nums" data-testid="scout-week">
            {data ? `${format(day(data.weekStart), "d MMM")} – ${format(day(data.weekEnd), "d MMM yyyy")}` : week}
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Next week" onClick={() => step(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <select
          aria-label="Scout plan farm"
          className={selectCls}
          value={farm || data?.farm || ""}
          onChange={(e) => {
            if (dirty && !window.confirm("Discard unsaved changes to this week?")) return;
            setFarm(e.target.value);
          }}
        >
          {(data?.farms || (farm ? [farm] : [])).map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <div role="group" aria-label="Scout rows" className="inline-flex rounded-lg bg-muted p-0.5">
          {(["greenhouse", "scout"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={rowsBy === v}
              onClick={() => {
                setRowsBy(v);
                setArmed(null);
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium",
                rowsBy === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {v === "greenhouse" ? "Greenhouse rows" : "Scout rows"}
            </button>
          ))}
        </div>
        {canEdit && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={copy} disabled={!data}>
              <Copy className="mr-1 h-3.5 w-3.5" /> Copy last week
            </Button>
            <Button size="sm" variant="outline" onClick={() => edit([])} disabled={!rows.length}>
              <Eraser className="mr-1 h-3.5 w-3.5" /> Clear week
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" onClick={() => data && adopt(data)} aria-label="Discard changes">
                <Undo2 className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={!dirty || saving}>
              <Save className="mr-1 h-3.5 w-3.5" /> {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-200">
          {error}
        </div>
      )}
      {note && (
        <div
          role={note.tone === "error" ? "alert" : "status"}
          data-testid="scout-note"
          className={cn(
            "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
            note.tone === "error" && "bg-red-500/10 text-red-800 dark:text-red-200",
            note.tone === "warn" && "bg-amber-500/10 text-amber-900 dark:text-amber-200",
            note.tone === "ok" && "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
          )}
        >
          <span className="flex-1 whitespace-pre-line">{note.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {data && check && (
        <div data-testid="scout-check" className="flex flex-wrap items-start gap-x-5 gap-y-2 rounded-xl border bg-card px-3 py-2 text-xs">
          <div>
            <div className="font-semibold">Coverage</div>
            <div className="text-muted-foreground">
              {data.greenhouses.length - check.unplanned.length}/{data.greenhouses.length} houses planned ·{" "}
              {rows.length} house-days · Done {tally.Done} · Missed {tally.Missed}
              {tally["On leave"] ? ` · On leave ${tally["On leave"]}` : ""}
              {unplanned.length ? ` · ${unplanned.length} unplanned scouted` : ""}
            </div>
          </div>
          <div className="min-w-0 max-w-full">
            <div className="font-semibold">Not planned this week ({check.unplanned.length})</div>
            <div className="flex flex-wrap gap-1 text-muted-foreground" data-testid="check-unplanned">
              {check.unplanned.length === 0
                ? "Every house has a scout."
                : check.unplanned.map((h) => (
                    <span key={h} className="rounded-full bg-muted px-1.5 py-0.5 text-foreground">
                      {shortGreenhouse(h, data.farm)}
                    </span>
                  ))}
            </div>
          </div>
          <div className="min-w-0">
            <div className="font-semibold">House-days per scout (median {check.median})</div>
            <div className="flex flex-wrap gap-1" data-testid="check-load">
              {check.load.map((l) => (
                <span
                  key={l.scout}
                  data-flag={l.flag || undefined}
                  className={cn(
                    "rounded-full px-1.5 py-0.5",
                    l.flag === "high" && "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
                    l.flag === "low" && "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
                    !l.flag && "bg-muted text-foreground",
                  )}
                  title={`${l.diff >= 0 ? "+" : ""}${l.diff} vs median`}
                >
                  {firstName(nameOf(l.scout))} {l.houseDays}
                </span>
              ))}
            </div>
          </div>
          {check.onLeave.length > 0 && (
            <div data-testid="check-on-leave">
              <div className="font-semibold text-amber-900 dark:text-amber-200">
                Planned scouts now on leave — reassign ({check.onLeave.length})
              </div>
              {check.onLeave.map((o) => (
                <div key={`${o.scout}-${o.date}-${o.greenhouse}`} className="text-muted-foreground">
                  {nameOf(o.scout)} · {format(day(o.date), "EEE d")} · {shortGreenhouse(o.greenhouse, data.farm)}
                </div>
              ))}
            </div>
          )}
          {check.conflicts.length > 0 && (
            <div data-testid="check-conflicts">
              <div className="font-semibold text-red-800 dark:text-red-300">Two farms the same day</div>
              {check.conflicts.map((c) => (
                <div key={`${c.scout}-${c.date}`} className="text-muted-foreground">
                  {nameOf(c.scout)} · {c.date} · {c.farms.join(" + ")}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="flex min-w-0 flex-col gap-3 lg:flex-row">
          {canEdit ? (
            <aside className="flex shrink-0 flex-col gap-1 rounded-xl border bg-card p-2 lg:w-56" data-testid="scout-picker">
              <div className="px-1 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {rowsBy === "greenhouse" ? `Scouts · ${pickDay ? format(day(pickDay), "EEE d") : ""}` : "Greenhouses"}
              </div>
              <div className="flex max-h-[420px] flex-row gap-1 overflow-auto lg:flex-col">
                {pickerItems.map((it) => {
                  const away = it.leave === "on_leave";
                  return (
                    <button
                      key={it.id}
                      type="button"
                      draggable={!away}
                      data-testid="picker-item"
                      data-leave={it.leave || undefined}
                      aria-pressed={armed === it.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", it.id);
                        setArmed(it.id);
                      }}
                      onClick={() => setArmed((a) => (a === it.id ? null : it.id))}
                      title={away ? `${it.label} is on approved leave on ${pickDay}` : it.label}
                      className={cn(
                        "flex min-w-[9rem] items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs",
                        armed === it.id ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                        away && "opacity-45 grayscale",
                      )}
                    >
                      {rowsBy === "greenhouse" && <PersonAvatar id={it.id} name={it.label} image={it.image} size={24} />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{it.label}</span>
                        {it.sub && <span className="block truncate text-[0.62rem] opacity-80">{it.sub}</span>}
                        {it.leaveNote && (
                          <span data-testid="picker-leave-note" className="block truncate text-[0.62rem] font-semibold">
                            {it.leaveNote}
                          </span>
                        )}
                      </span>
                      {it.leave && (
                        <span className="shrink-0 text-[0.58rem] font-semibold">
                          {it.leave === "on_leave" ? "Leave" : "Pending"}
                        </span>
                      )}
                    </button>
                  );
                })}
                {pickerItems.length === 0 && (
                  <span className="px-1 py-2 text-xs text-muted-foreground">No scouts logged entries here in the last four weeks.</span>
                )}
              </div>
            </aside>
          ) : (
            <div className="text-xs text-muted-foreground lg:hidden">Read-only: you can view this plan.</div>
          )}

          <div className="min-w-0 flex-1 overflow-x-auto rounded-xl border bg-card" data-testid="scout-grid">
            <div className="grid min-w-[780px]" style={{ gridTemplateColumns: cols }}>
              <div className="sticky left-0 z-10 border-b bg-muted px-2 py-1.5 text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {rowsBy === "greenhouse" ? "Greenhouse" : "Scout"}
              </div>
              {days.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setFocusDay(d)}
                  aria-pressed={pickDay === d}
                  className={cn(
                    "border-b px-1 py-1 text-center text-[0.65rem] tabular-nums",
                    pickDay === d ? "bg-primary/10 font-semibold text-foreground" : "bg-muted/40 text-muted-foreground",
                  )}
                >
                  {format(day(d), "EEE d")}
                  {d === today && <span className="ml-1 rounded bg-primary px-1 text-primary-foreground">today</span>}
                </button>
              ))}
              {gridRows.map((gr) => (
                <div key={gr.id} className="contents" data-testid="scout-row">
                  <div className="sticky left-0 z-10 flex items-center truncate border-b bg-card px-2 py-1 text-[0.72rem] font-semibold" title={gr.id}>
                    {gr.label}
                  </div>
                  {days.map((d) => {
                    const here = inCell(gr.id, d);
                    const ghosts = ghostsIn(gr.id, d);
                    const target = canEdit ? cellTarget(gr.id, d) : null;
                    const isBlocked = canEdit && blocked(gr.id, d);
                    const place = () => {
                      if (!target) return;
                      if (isBlocked) {
                        setNote({ tone: "error", text: `${nameOf(target.scout)} is on approved leave on ${d}.` });
                        return;
                      }
                      assign(target);
                    };
                    return (
                      <div
                        key={d}
                        data-testid={`scout-cell-${gr.id}-${d}`}
                        data-blocked={isBlocked ? "true" : undefined}
                        // Keyboard path: with a scout picked, Tab to a cell and press Enter/Space.
                        role={target ? "button" : undefined}
                        tabIndex={target ? 0 : undefined}
                        aria-disabled={target && isBlocked ? true : undefined}
                        aria-label={target ? `Assign ${nameOf(target.scout)} to ${gr.label}, ${d}` : undefined}
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            place();
                          }
                        }}
                        onClick={place}
                        onDragOver={(e) => canEdit && e.preventDefault()}
                        onDrop={(e) => canEdit && onDrop(e, gr.id, d)}
                        className={cn(
                          "flex min-h-[44px] flex-wrap content-start gap-1 border-b border-l p-1",
                          target && !isBlocked && "cursor-copy hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isBlocked && "cursor-not-allowed bg-muted/60",
                        )}
                      >
                        {here.map((r) => {
                          const st = statusFor(r, data.actuals, today, leaves);
                          const tone = paint(ASSIGNMENT_COLORS[st]);
                          const label = rowsBy === "greenhouse" ? firstName(nameOf(r.scout)) : shortGreenhouse(r.greenhouse, data.farm);
                          return (
                            <button
                              key={rowKey(r)}
                              type="button"
                              data-testid="plan-chip"
                              data-status={st}
                              disabled={!canEdit}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (canEdit) edit(removeAssignment(rows, r));
                              }}
                              title={`${nameOf(r.scout)} · ${r.greenhouse} · ${st}${canEdit ? " — click to remove" : ""}`}
                              className={cn("inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-0.5 pr-1.5 text-[0.62rem] font-medium", tone.className)}
                              style={tone.style}
                            >
                              {rowsBy === "greenhouse" && (
                                <PersonAvatar id={r.scout} name={nameOf(r.scout)} image={scouts.get(r.scout)?.image} size={18} />
                              )}
                              <span className="truncate">{label}</span>
                              {st === "Done" && <Check className="h-2.5 w-2.5 shrink-0" aria-label="Done" />}
                              {st === "Missed" && <X className="h-2.5 w-2.5 shrink-0" aria-label="Missed" />}
                              {st === "On leave" && <span className="shrink-0 text-[0.55rem] font-semibold">On leave</span>}
                            </button>
                          );
                        })}
                        {ghosts.map((a) => (
                          <span
                            key={`u-${rowKey(a)}`}
                            data-testid="unplanned-chip"
                            title={`${nameOf(a.scout)} scouted ${a.greenhouse} (${a.entries} entries) — not planned`}
                            className="inline-flex max-w-full items-center gap-1 rounded-full border border-dashed border-muted-foreground/50 py-0.5 pl-0.5 pr-1.5 text-[0.62rem] text-muted-foreground"
                          >
                            {rowsBy === "greenhouse" && (
                              <PersonAvatar id={a.scout} name={nameOf(a.scout)} image={scouts.get(a.scout)?.image} size={16} className="opacity-70" />
                            )}
                            <span className="truncate">
                              {rowsBy === "greenhouse" ? firstName(nameOf(a.scout)) : shortGreenhouse(a.greenhouse, data.farm)}
                            </span>
                          </span>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {loading && !data && <div className="text-sm text-muted-foreground">Loading the scout plan…</div>}
    </div>
  );
}
