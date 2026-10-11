/**
 * Spray team editor for the Application Floor Plan flow.
 *
 * Two coupled controls in one component:
 *   1. A "Spray Team" picker — picking a team seeds the member roster from
 *      the master `Spray Team Details` list. Clearing the picker or
 *      switching teams replaces the roster.
 *   2. An editable per-plan roster below. The operator can add, remove,
 *      and re-role members WITHOUT touching the master team — this is the
 *      whole point: each Application Floor Plan can have its own roster.
 *
 * The composed value is submitted as the WO's `custom_spray_plan_team_members`
 * child table; `auto_material_issue.py` reads that table first and only
 * falls back to the team's master list when it is empty.
 *
 * The roster surfaces both the Employee ID (payroll number at Upande) and
 * the real `employee_name` — fixing the legacy chips that showed only IDs.
 */

import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Search, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  searchEmployees,
  type CreatorSprayTeam,
  type EmployeeSearchHit,
} from "@/lib/spray-plan-creator-api";
import { fetchSprayTeams, type SprayTeam } from "@/lib/teams-api";
import { EditTeamDialog } from "@/components/teams/EditTeamDialog";
import { CrewBadge } from "@/components/spray-plan/CrewBadge";
import { AvatarSkeleton, Bar, TextSkeleton } from "@/components/Loading";
import {
  fetchCrewAvailability,
  type CrewAvailability,
} from "@/lib/schedule-api";

/** Row shape held in component state. Mirrors `Custom Spray Plan Team Member`
 *  plus a display name we pre-resolved client-side. */
export interface TeamMemberRow {
  employee: string;
  employee_name: string;
  designation?: string | null;
  role: string;
}

const ROLE_OPTIONS = ["Supervisor", "Sprayer", "Pump Operator"] as const;
const ROLE_NONE = "__none__";

interface Props {
  teams: CreatorSprayTeam[];
  team: string;
  onTeamChange: (next: string) => void;
  members: TeamMemberRow[];
  onMembersChange: (next: TeamMemberRow[]) => void;
  /** crop the plan is for — scopes which master teams the user may edit */
  crop?: string;
  /** yyyy-mm-dd plan date: when given, each member shows a leave badge for it */
  onDate?: string;
}

/** Same people with the same roles, in any order. "Not customised" (E3). */
export function rosterMatches(
  plan: { employee: string; role?: string | null }[],
  master: { employee: string; role?: string | null }[],
): boolean {
  if (plan.length !== master.length) return false;
  const key = (m: { employee: string; role?: string | null }) => `${m.employee}\u0000${m.role || ""}`;
  const want = new Set(master.map(key));
  return plan.every((m) => want.has(key(m)));
}

function rowsOf(team: { members: CreatorSprayTeam["members"] | SprayTeam["members"] }): TeamMemberRow[] {
  return (team.members || []).map((m) => ({
    employee: m.employee,
    employee_name: m.employee_name || m.employee,
    designation: m.designation,
    role: m.role || "",
  }));
}

/** Build "GK" from "GLADYS JEPKOECH KOSGEI" — used in the avatar circle. */
function initialsOf(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Hash a string to a hue (0–360). Stable per-employee avatar tint. */
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function SprayTeamEditor({
  teams,
  team,
  onTeamChange,
  members,
  onMembersChange,
  crop,
  onDate,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Master teams this user may edit — the server decides (E5); a refusal
  // means no "Edit team" button at all.
  const [manageable, setManageable] = useState<Record<string, SprayTeam>>({});
  const [editOpen, setEditOpen] = useState(false);
  /** a team saved while this plan kept its own roster (E3) */
  const [updated, setUpdated] = useState<SprayTeam | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSprayTeams(crop)
      .then((rows) => alive && setManageable(Object.fromEntries((rows || []).map((t) => [t.name, t]))))
      .catch(() => alive && setManageable({}));
    return () => {
      alive = false;
    };
  }, [crop]);

  // Leave / check-in badges for the plan date. Advisory only: planning never
  // refuses on availability, the morning confirmation does (per the setting).
  const [avail, setAvail] = useState<CrewAvailability | null>(null);
  const memberKey = members.map((m) => m.employee).sort().join(",");
  useEffect(() => {
    if (!onDate || !memberKey) {
      setAvail(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      fetchCrewAvailability({ employees: memberKey.split(","), on_date: onDate })
        .then((r) => alive && setAvail(r))
        .catch(() => alive && setAvail(null));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [onDate, memberKey]);
  const unavailable = avail
    ? members.filter((m) => {
        const st = avail.members?.[m.employee]?.status;
        return st && st !== "ok";
      }).length
    : 0;

  const canEditAny = Object.keys(manageable).length > 0;
  const editable = team ? manageable[team] || null : null;
  const showEdit = canEditAny && (!team || !!editable);

  const onTeamSaved = (saved: SprayTeam, before: SprayTeam) => {
    setManageable((m) => ({ ...m, [saved.name]: saved }));
    if (team !== saved.name) return;
    if (rosterMatches(members, before.members)) {
      onMembersChange(rowsOf(saved));
      setUpdated(null);
    } else {
      setUpdated(saved);
    }
  };
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EmployeeSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drive search-result fetch with a 200 ms debounce.
  useEffect(() => {
    if (!pickerOpen) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      searchEmployees(query, 25)
        .then((rows) => setResults(rows))
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, pickerOpen]);

  // Picking a team seeds the roster from its master members — we
  // overwrite, not merge, because picking a different team is the
  // operator's way of saying "start from this list". Clearing the team
  // KEEPS the current roster (use the trash button per row to drop
  // people); the "Clear team" affordance is for breaking the link with
  // the master team without losing customizations.
  const onPickTeam = (next: string) => {
    onTeamChange(next);
    setUpdated(null);
    if (!next) return;
    // A team saved from this page seeds from what was saved, not the
    // (older) list the page loaded with.
    const t = manageable[next] || teams.find((x) => x.name === next);
    onMembersChange(t ? rowsOf(t) : []);
  };

  const addEmployee = (hit: EmployeeSearchHit) => {
    if (members.some((m) => m.employee === hit.employee)) return;
    onMembersChange([
      ...members,
      {
        employee: hit.employee,
        employee_name: hit.employee_name || hit.employee,
        designation: hit.designation,
        role: "",
      },
    ]);
    setPickerOpen(false);
    setQuery("");
  };

  const updateRole = (employee: string, role: string) =>
    onMembersChange(
      members.map((m) =>
        m.employee === employee ? { ...m, role: role === ROLE_NONE ? "" : role } : m,
      ),
    );

  const removeMember = (employee: string) =>
    onMembersChange(members.filter((m) => m.employee !== employee));

  const counts = {
    total: members.length,
    supervisors: members.filter((m) => m.role === "Supervisor").length,
    sprayers: members.filter((m) => m.role === "Sprayer").length,
    pump: members.filter((m) => m.role === "Pump Operator").length,
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            Spray Team
          </span>
          {team && (
            <button
              type="button"
              onClick={() => onPickTeam("")}
              className="text-[0.62rem] uppercase tracking-wide font-semibold text-muted-foreground hover:text-foreground transition-colors"
              title="Clear the picked team — the current roster stays in place."
            >
              Clear team
            </button>
          )}
        </Label>
        <div className="flex items-center gap-2">
        <Select value={team} onValueChange={onPickTeam}>
          <SelectTrigger className="h-9 min-w-0 flex-1">
            <SelectValue placeholder="Pick a team to seed the roster…" />
          </SelectTrigger>
          <SelectContent>
            {teams.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                <span className="flex items-center gap-2">
                  <span>{t.name}</span>
                  <span className="text-[0.65rem] text-muted-foreground tabular-nums">
                    · {t.members.length} member{t.members.length === 1 ? "" : "s"}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showEdit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 shrink-0 gap-1.5"
            disabled={!editable}
            onClick={() => setEditOpen(true)}
            title={editable ? "Edit this team for all future plans" : "Pick a team to edit it"}
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit team
          </Button>
        )}
        </div>
        <p className="text-[0.65rem] text-muted-foreground leading-snug">
          Picking a team copies its members below. Add or remove individuals for
          this plan — the master team list is left untouched. Use Edit team to
          change the team itself.
        </p>
        {updated && updated.name === team && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[0.72rem]"
          >
            <span className="text-muted-foreground">
              {updated.team_name || updated.name} was updated. This plan keeps its own roster.
            </span>
            <span className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 text-[0.7rem]"
                onClick={() => {
                  onMembersChange(rowsOf(updated));
                  setUpdated(null);
                }}
              >
                Use the updated team for this plan
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="Dismiss"
                onClick={() => setUpdated(null)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </span>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-[var(--sd-bg-soft)]">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[0.7rem] uppercase tracking-[0.08em] font-semibold text-foreground/80">
              Team On Ground
            </span>
            <span
              className={
                "text-[0.62rem] tabular-nums font-bold px-1.5 py-0.5 rounded-full " +
                (counts.total
                  ? "bg-primary/15 text-primary"
                  : "bg-muted text-muted-foreground")
              }
            >
              {counts.total}
            </span>
            {counts.total > 0 && (
              <span className="text-[0.65rem] text-muted-foreground tabular-nums truncate hidden sm:inline">
                {counts.supervisors > 0 && `${counts.supervisors} sup · `}
                {counts.sprayers > 0 && `${counts.sprayers} spr · `}
                {counts.pump > 0 && `${counts.pump} pump`}
              </span>
            )}
            {unavailable > 0 && avail && (
              <span
                className="text-[0.62rem] font-semibold text-red-700 dark:text-red-300 whitespace-nowrap"
                title={`Crew leave check: ${avail.mode}. Planning only warns; the morning confirmation ${avail.mode === "Block" ? "refuses" : "warns"}.`}
              >
                {unavailable} unavailable on {avail.on_date}
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-[0.7rem]"
            onClick={() => {
              setQuery("");
              setPickerOpen(true);
            }}
          >
            <Plus className="h-3 w-3" />
            Add member
          </Button>
        </div>

        {members.length === 0 ? (
          <div className="px-6 py-8 text-center">
            <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Users className="h-4 w-4" />
            </div>
            <div className="text-[0.78rem] font-medium text-foreground">
              No one assigned yet
            </div>
            <div className="text-[0.7rem] text-muted-foreground mt-1 max-w-xs mx-auto leading-snug">
              Pick a Spray Team above to seed the roster, or click{" "}
              <span className="font-medium text-foreground">Add member</span> to
              build it from scratch.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {members.map((m) => (
              <li
                key={m.employee}
                className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors"
              >
                <div
                  className="flex h-9 w-9 items-center justify-center rounded-full text-[0.7rem] font-bold tracking-tight"
                  style={{
                    background: `hsl(${hueOf(m.employee)} 70% 92%)`,
                    color: `hsl(${hueOf(m.employee)} 55% 28%)`,
                  }}
                  aria-hidden
                >
                  {initialsOf(m.employee_name || m.employee)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[0.82rem] font-semibold text-foreground truncate">
                      {m.employee_name || m.employee}
                    </span>
                    <CrewBadge
                      status={avail?.members?.[m.employee]?.status}
                      halfDay={avail?.members?.[m.employee]?.half_day}
                    />
                  </div>
                  <div className="text-[0.65rem] text-muted-foreground font-mono tabular-nums truncate">
                    #{m.employee}
                    {m.designation ? (
                      <span className="ml-1.5 not-italic font-sans text-muted-foreground/80">
                        · {m.designation}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Select
                  value={m.role || ROLE_NONE}
                  onValueChange={(v) => updateRole(m.employee, v)}
                >
                  <SelectTrigger className="h-7 w-32 text-[0.7rem]">
                    <SelectValue placeholder="Role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ROLE_NONE}>
                      <span className="text-muted-foreground italic">
                        No role
                      </span>
                    </SelectItem>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeMember(m.employee)}
                  title="Remove from this plan"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <EditTeamDialog
        team={editable}
        open={editOpen && !!editable}
        onOpenChange={setEditOpen}
        crop={crop}
        onDate={onDate}
        onSaved={onTeamSaved}
      />

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              Add team member
            </DialogTitle>
            <DialogDescription>
              Search by name or payroll number. Active employees only.
            </DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a name or payroll number…"
              autoFocus
              className="pl-8"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border" aria-busy={searching || undefined}>
            {searching && !results.length ? (
              // Result rows at their own height — avatar, name, employee number.
              <ul className="divide-y" aria-hidden>
                {["9rem", "7rem", "11rem", "8rem"].map((w, i) => (
                  <li key={i} className="px-3 py-2 flex items-center gap-3" data-skeleton="row">
                    <AvatarSkeleton size={36} />
                    <div className="min-w-0 flex-1 flex flex-col gap-1">
                      <TextSkeleton width={w} />
                      <Bar className="h-2.5 w-24" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {query
                  ? `No active employees match "${query}".`
                  : "Type to search active employees."}
              </div>
            ) : (
              <ul className="divide-y">
                {results.map((hit) => {
                  const already = members.some((m) => m.employee === hit.employee);
                  return (
                    <li key={hit.employee}>
                      <button
                        type="button"
                        onClick={() => !already && addEmployee(hit)}
                        disabled={already}
                        className={
                          "w-full text-left px-3 py-2 flex items-center gap-3 transition-colors " +
                          (already
                            ? "opacity-50 cursor-not-allowed bg-muted/30"
                            : "hover:bg-muted/40")
                        }
                      >
                        <div
                          className="flex h-9 w-9 items-center justify-center rounded-full text-[0.7rem] font-bold tracking-tight shrink-0"
                          style={{
                            background: `hsl(${hueOf(hit.employee)} 70% 92%)`,
                            color: `hsl(${hueOf(hit.employee)} 55% 28%)`,
                          }}
                          aria-hidden
                        >
                          {initialsOf(hit.employee_name || hit.employee)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[0.82rem] font-semibold text-foreground truncate">
                            {hit.employee_name || hit.employee}
                          </div>
                          <div className="text-[0.65rem] text-muted-foreground font-mono tabular-nums truncate">
                            #{hit.employee}
                            {hit.designation ? (
                              <span className="ml-1.5 font-sans text-muted-foreground/80">
                                · {hit.designation}
                              </span>
                            ) : null}
                            {hit.department ? (
                              <span className="ml-1.5 font-sans text-muted-foreground/60">
                                · {hit.department}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        {already ? (
                          <span className="text-[0.6rem] uppercase tracking-wide font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            On plan
                          </span>
                        ) : (
                          <Plus className="h-3.5 w-3.5 text-primary shrink-0" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
