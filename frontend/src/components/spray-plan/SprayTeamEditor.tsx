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
import { Loader2, Plus, Search, Trash2, Users, X } from "lucide-react";
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
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
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
    if (!next) return;
    const t = teams.find((x) => x.name === next);
    const seeded: TeamMemberRow[] = (t?.members || []).map((m) => ({
      employee: m.employee,
      employee_name: m.employee_name || m.employee,
      designation: m.designation,
      role: m.role || "",
    }));
    onMembersChange(seeded);
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
        <Select value={team} onValueChange={onPickTeam}>
          <SelectTrigger className="h-9">
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
        <p className="text-[0.65rem] text-muted-foreground leading-snug">
          Picking a team copies its members below. Add or remove individuals for
          this plan — the master team list is left untouched.
        </p>
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
                  <div className="text-[0.82rem] font-semibold text-foreground truncate">
                    {m.employee_name || m.employee}
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
          <div className="max-h-80 overflow-auto rounded-lg border">
            {searching ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching…
              </div>
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
