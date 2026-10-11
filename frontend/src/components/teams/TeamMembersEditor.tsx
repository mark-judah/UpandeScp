/**
 * A master spray team's members: photo, name, ID, designation and role, with
 * remove per row and an Employee search (limited server-side to the farm's
 * company) to add. Shared by the Teams page cards and the "Edit team" modal on
 * the Application Plan.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import {
  TEAM_ROLES,
  searchEmployees,
  type EmployeeHit,
  type TeamMember,
  type TeamRole,
} from "@/lib/teams-api";

/** Same members in the same order with the same roles. */
export function sameMembers(a: TeamMember[], b: TeamMember[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.employee === b[i].employee && m.role === b[i].role);
}

function MemberSearch({
  farm,
  crop,
  exclude,
  onPick,
}: {
  farm: string | null;
  crop?: string;
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
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          aria-label="Add member"
          placeholder={farm ? "Add a member — search name or ID" : "Set the team's farm first"}
          className="pl-8"
          value={txt}
          disabled={!farm}
          onChange={(e) => setTxt(e.target.value)}
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
                  <span className="truncate">
                    {h.employee_name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{h.employee}</span>
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
}: {
  members: TeamMember[];
  onChange: (next: TeamMember[]) => void;
  /** the team's farm — Employee search is limited to its company */
  farm: string | null;
  crop?: string;
}) {
  const memberIds = useMemo(() => new Set(members.map((m) => m.employee)), [members]);
  const setMember = (i: number, patch: Partial<TeamMember>) =>
    onChange(members.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <div className="flex flex-col gap-3">
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
