/**
 * Spray teams of the user's farms. Add or remove members (Employee search is
 * limited to the farm's company, server-side), set roles, the team's farm, and
 * enable or disable it. Saving re-syncs the changed members into the sprayer
 * register (the Spray Team on_update hook).
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RotateCcw, Save, Search, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  TEAM_ROLES,
  saveSprayTeam,
  searchEmployees,
  type EmployeeHit,
  type SprayTeam,
  type TeamMember,
  type TeamRole,
  type TeamsContext,
} from "@/lib/teams-api";

const NO_FARM = "__none__";

function sameTeam(a: SprayTeam, b: SprayTeam): boolean {
  if (a.farm !== b.farm || !!a.enabled !== !!b.enabled) return false;
  if (a.members.length !== b.members.length) return false;
  return a.members.every(
    (m, i) => m.employee === b.members[i].employee && m.role === b.members[i].role,
  );
}

function MemberSearch({
  farm,
  crop,
  exclude,
  onPick,
}: {
  farm: string | null;
  crop: string;
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
                <span className="truncate">
                  {h.employee_name}{" "}
                  <span className="font-mono text-xs text-muted-foreground">{h.employee}</span>
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

function TeamCard({
  team,
  ctx,
  crop,
  onSaved,
}: {
  team: SprayTeam;
  ctx: TeamsContext;
  crop: string;
  onSaved: (t: SprayTeam) => void;
}) {
  const [draft, setDraft] = useState<SprayTeam>(team);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(team), [team]);

  const dirty = !sameTeam(draft, team);
  const memberIds = useMemo(() => new Set(draft.members.map((m) => m.employee)), [draft]);

  const setMember = (i: number, patch: Partial<TeamMember>) =>
    setDraft((d) => ({
      ...d,
      members: d.members.map((m, j) => (j === i ? { ...m, ...patch } : m)),
    }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSprayTeam(
        team.name,
        {
          members: draft.members.map((m) => ({ employee: m.employee, role: m.role })),
          ...(draft.farm !== team.farm ? { farm: draft.farm } : {}),
          ...(!!draft.enabled !== !!team.enabled ? { enabled: !!draft.enabled } : {}),
        },
        crop,
      );
      onSaved(saved);
    } catch (e) {
      setError((e as Error)?.message || "Could not save the team");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid={`team-${team.name}`}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
          <CardTitle className="truncate text-base">{team.team_name || team.name}</CardTitle>
          <Badge variant="secondary">{draft.members.length}</Badge>
          {!draft.enabled && <Badge variant="outline">Disabled</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={draft.farm || NO_FARM}
            onValueChange={(v) => setDraft((d) => ({ ...d, farm: v === NO_FARM ? null : v }))}
          >
            <SelectTrigger aria-label={`Farm of ${team.name}`} className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(ctx.manager || !team.farm) && <SelectItem value={NO_FARM}>No farm</SelectItem>}
              {ctx.farms.map((f) => (
                <SelectItem key={f} value={f}>{f}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              aria-label={`Enabled ${team.name}`}
              checked={!!draft.enabled}
              onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v ? 1 : 0 }))}
            />
            Enabled
          </label>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
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
            {draft.members.map((m, i) => (
              <TableRow key={m.employee}>
                <TableCell>
                  <div className="font-medium">{m.employee_name}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {m.employee}
                    {m.sprayer ? ` · ${m.sprayer}` : ""}
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
                    onClick={() =>
                      setDraft((d) => ({ ...d, members: d.members.filter((_, j) => j !== i) }))
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {draft.members.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                  No members yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <MemberSearch
          farm={draft.farm}
          crop={crop}
          exclude={memberIds}
          onPick={(h) =>
            setDraft((d) => ({
              ...d,
              members: [
                ...d.members,
                {
                  employee: h.employee,
                  employee_name: h.employee_name,
                  designation: h.designation,
                  role: "Sprayer",
                },
              ],
            }))
          }
        />

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => setDraft(team)}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
          </Button>
          <Button type="button" size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save team
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SprayTeamsTab({
  teams,
  ctx,
  crop,
  onSaved,
}: {
  teams: SprayTeam[];
  ctx: TeamsContext;
  crop: string;
  onSaved: (t: SprayTeam) => void;
}) {
  if (!teams.length) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No spray teams on your farms.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {teams.map((t) => (
        <TeamCard key={t.name} team={t} ctx={ctx} crop={crop} onSaved={onSaved} />
      ))}
    </div>
  );
}
