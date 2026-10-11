/**
 * Spray teams of the user's farms. Add or remove members (Employee search is
 * limited to the farm's company, server-side), set roles, the team's farm, and
 * enable or disable it. Saving re-syncs the changed members into the sprayer
 * register (the Spray Team on_update hook).
 */
import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Save, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { TableRowsSkeleton, TextSkeleton } from "@/components/Loading";
import { TeamMembersEditor, sameMembers } from "@/components/teams/TeamMembersEditor";
import { saveSprayTeam, type SprayTeam, type TeamsContext } from "@/lib/teams-api";

const NO_FARM = "__none__";

function sameTeam(a: SprayTeam, b: SprayTeam): boolean {
  if (a.farm !== b.farm || !!a.enabled !== !!b.enabled) return false;
  return sameMembers(a.members, b.members);
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
        <TeamMembersEditor
          members={draft.members}
          onChange={(members) => setDraft((d) => ({ ...d, members }))}
          farm={draft.farm}
          crop={crop}
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

/** The team cards on the first load: each card's controls and the members
 *  table's columns are drawn; the team name and the members are pending. */
export function SprayTeamsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2" aria-busy="true">
      {Array.from({ length: cards }, (_, i) => (
        <Card key={i} data-skeleton="team">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
            <div className="flex min-w-0 items-center gap-2">
              <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
              <TextSkeleton width="14ch" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Select disabled>
                <SelectTrigger aria-label="Farm" className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
              </Select>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox disabled aria-label="Enabled" />
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
                <TableRowsSkeleton cols={4} rows={4} avatar />
              </TableBody>
            </Table>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reset
              </Button>
              <Button type="button" size="sm" disabled>
                <Save className="mr-1.5 h-3.5 w-3.5" />
                Save team
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
