/**
 * A master spray team's members: photo, name, ID, designation and role, with
 * remove per row and an Employee search (limited server-side to the farm's
 * company) to add. Shared by the Teams page cards and the "Edit team" modal on
 * the Application Plan.
 *
 * Each member (and each search hit) shows their approved or pending leave over
 * the next two weeks from the plan date (else today), so whoever edits the team
 * sees who is away. Informational only: leave never stops a member being added.
 */
import { SearchInput } from "@/components/SearchInput";
import { useEffect, useMemo, useState } from "react";
import { CalendarOff, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { CrewBadge } from "@/components/spray-plan/CrewBadge";
import { cn } from "@/lib/utils";
import {
  TEAM_ROLES,
  fetchMemberLeave,
  searchEmployees,
  type EmployeeHit,
  type MemberLeave,
  type MemberLeaveResult,
  type TeamMember,
  type TeamRole,
} from "@/lib/teams-api";

/** Same members in the same order with the same roles. */
export function sameMembers(a: TeamMember[], b: TeamMember[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.employee === b[i].employee && m.role === b[i].role);
}

/** Leave for a set of employees from a date; refetched when the set changes. */
function useMemberLeave(ids: string[], onDate?: string, crop?: string): MemberLeaveResult | null {
  const [res, setRes] = useState<MemberLeaveResult | null>(null);
  const key = [...ids].sort().join(",");
  useEffect(() => {
    if (!key) {
      setRes(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      fetchMemberLeave(key.split(","), onDate, crop)
        .then((r) => alive && setRes(r))
        .catch(() => alive && setRes(null));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, onDate, crop]);
  return res;
}

function span(from: string, to: string): string {
  const a = parseISO(from);
  const b = parseISO(to);
  if (from === to) return format(a, "d MMM");
  return a.getMonth() === b.getMonth()
    ? `${format(a, "d")}–${format(b, "d MMM")}`
    : `${format(a, "d MMM")}–${format(b, "d MMM")}`;
}

/** "On leave" pill for the first day, then each leave in the window ("Leave 14–17 Oct"). */
export function MemberLeaveNote({ leave, className }: { leave?: MemberLeave; className?: string }) {
  if (!leave || (leave.status === "ok" && leave.leaves.length === 0)) return null;
  return (
    <div data-testid="member-leave" className={cn("flex flex-wrap items-center gap-1", className)}>
      <CrewBadge status={leave.status} halfDay={leave.half_day} />
      {leave.leaves.map((l) => (
        <span
          key={`${l.from_date}-${l.state}`}
          data-state={l.state}
          className={cn(
            "inline-flex items-center gap-0.5 whitespace-nowrap text-[0.65rem]",
            l.state === "approved" ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300",
          )}
        >
          <CalendarOff className="h-3 w-3" />
          {l.state === "approved" ? "Leave" : "Leave pending"} {span(l.from_date, l.to_date)}
          {l.half_day ? " (half day)" : ""}
        </span>
      ))}
    </div>
  );
}

function MemberSearch({
  farm,
  crop,
  onDate,
  exclude,
  onPick,
}: {
  farm: string | null;
  crop?: string;
  onDate?: string;
  exclude: Set<string>;
  onPick: (hit: EmployeeHit) => void;
}) {
  const [txt, setTxt] = useState("");
  const [hits, setHits] = useState<EmployeeHit[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (txt.trim().length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      searchEmployees(farm, txt.trim(), crop)
        .then((r) => alive && setHits(r))
        .catch(() => alive && setHits([]))
        .finally(() => alive && setBusy(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [txt, farm, crop]);

  const shown = hits.filter((h) => !exclude.has(h.employee));
  const leave = useMemberLeave(shown.map((h) => h.employee), onDate, crop);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <SearchInput size="md"
          aria-label="Add member"
          placeholder={farm ? "Add a member — search name or ID" : "Set the team's farm first"}
          value={txt}
          disabled={!farm}
          onChange={setTxt}
        />
        {busy && (
          <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {shown.length > 0 && (
        <ul className="max-h-48 overflow-auto rounded-md border bg-popover text-sm" role="listbox">
          {shown.map((h) => (
            <li key={h.employee}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  onPick(h);
                  setTxt("");
                  setHits([]);
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PersonAvatar id={h.employee} name={h.employee_name} image={h.image} size={24} />
                  <span className="min-w-0">
                    <span className="block truncate">
                      {h.employee_name}{" "}
                      <span className="font-mono text-xs text-muted-foreground">{h.employee}</span>
                    </span>
                    <MemberLeaveNote leave={leave?.members?.[h.employee]} />
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  {h.designation}
                  <Plus className="h-3.5 w-3.5" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TeamMembersEditor({
  members,
  onChange,
  farm,
  crop,
  onDate,
}: {
  members: TeamMember[];
  onChange: (next: TeamMember[]) => void;
  /** the team's farm — Employee search is limited to its company */
  farm: string | null;
  crop?: string;
  /** yyyy-mm-dd: leave is shown from this day (the plan date); today when absent */
  onDate?: string;
}) {
  const memberIds = useMemo(() => new Set(members.map((m) => m.employee)), [members]);
  const leave = useMemberLeave(members.map((m) => m.employee), onDate, crop);
  const away = leave ? members.filter((m) => (leave.members?.[m.employee]?.leaves.length ?? 0) > 0) : [];
  const awayNow = away.filter((m) => leave?.members?.[m.employee]?.status === "on_leave");
  const setMember = (i: number, patch: Partial<TeamMember>) =>
    onChange(members.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <div className="flex flex-col gap-3">
      {leave && away.length > 0 && (
        <p
          role="status"
          data-testid="team-leave-summary"
          className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
        >
          <CalendarOff className="h-3.5 w-3.5 shrink-0" />
          <span>
            {away.length} of {members.length} {members.length === 1 ? "member has" : "members have"} leave
            between {format(parseISO(leave.from_date), "d MMM")} and {format(parseISO(leave.to_date), "d MMM")}
            {awayNow.length > 0 ? ` — ${awayNow.length} on leave on ${format(parseISO(leave.from_date), "d MMM")}` : ""}.
          </span>
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead className="hidden sm:table-cell">Designation</TableHead>
            <TableHead>Role</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((m, i) => (
            <TableRow key={m.employee}>
              <TableCell>
                <div className="flex min-w-0 items-center gap-2.5">
                  <PersonAvatar id={m.employee} name={m.employee_name} image={m.image} size={32} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.employee_name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {m.employee}
                      {m.sprayer ? ` · ${m.sprayer}` : ""}
                    </div>
                    <MemberLeaveNote leave={leave?.members?.[m.employee]} className="mt-0.5" />
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                {m.designation || "—"}
              </TableCell>
              <TableCell>
                <Select value={m.role} onValueChange={(v) => setMember(i, { role: v as TeamRole })}>
                  <SelectTrigger aria-label={`Role of ${m.employee_name}`} className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEAM_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${m.employee_name}`}
                  onClick={() => onChange(members.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {members.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                No members yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <MemberSearch
        farm={farm}
        crop={crop}
        onDate={onDate}
        exclude={memberIds}
        onPick={(h) =>
          onChange([
            ...members,
            {
              employee: h.employee,
              employee_name: h.employee_name,
              designation: h.designation,
              image: h.image,
              role: "Sprayer",
            },
          ])
        }
      />
    </div>
  );
}
