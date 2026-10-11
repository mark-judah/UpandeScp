/**
 * "Edit team" modal opened from the Application Plan: edits the MASTER spray
 * team (every future plan), not this plan's roster. Saves through
 * `save_spray_team`, which scopes to the user's farms and refuses members from
 * another company. A refusal is shown here and the edits are kept.
 */
import { useEffect, useState } from "react";
import { Loader2, Save, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { TeamMembersEditor, sameMembers } from "@/components/teams/TeamMembersEditor";
import { saveSprayTeam, type SprayTeam, type TeamMember } from "@/lib/teams-api";

export function EditTeamDialog({
  team,
  open,
  onOpenChange,
  crop,
  onSaved,
}: {
  team: SprayTeam | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  crop?: string;
  /** the saved team, and the master team as it was before the save */
  onSaved: (saved: SprayTeam, before: SprayTeam) => void;
}) {
  const [members, setMembers] = useState<TeamMember[]>(team?.members || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh copy of the master team every time the modal opens.
  useEffect(() => {
    if (open) {
      setMembers(team?.members || []);
      setError(null);
    }
  }, [open, team]);

  if (!team) return null;
  const label = team.team_name || team.name;
  const dirty = !sameMembers(members, team.members);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSprayTeam(
        team.name,
        { members: members.map((m) => ({ employee: m.employee, role: m.role })) },
        crop,
      );
      onSaved(saved, team);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error)?.message || "Could not save the team");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !saving && onOpenChange(v)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Edit team · {label}
          </DialogTitle>
          <DialogDescription>
            Changes apply to {label} for all future plans.
            {team.farm ? ` Members can be added from ${team.farm}'s company.` : ""}
          </DialogDescription>
        </DialogHeader>

        <TeamMembersEditor members={members} onChange={setMembers} farm={team.farm} crop={crop} />

        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!dirty || saving} onClick={save}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save to team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
