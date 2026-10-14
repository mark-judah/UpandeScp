/**
 * Personnel ▸ Teams — spray team configuration (personnel spec P1, P6).
 *
 * This is the spray plan creator's page: a creator sees and edits only the
 * teams of the farms on their `spray_plan_creators` roster, a supervisor those
 * of their `spray_supervisors` roster, a General Manager / System Manager every
 * farm they can see. The server (serverscripts/sprayers/api.py) enforces that;
 * the page shows what it returns and surfaces its refusals.
 */
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { SprayTeamsSkeleton, SprayTeamsTab } from "@/components/teams/SprayTeamsTab";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import {
  fetchSprayTeams,
  fetchTeamsContext,
  type SprayTeam,
  type TeamsContext,
} from "@/lib/teams-api";

export function Teams({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const [ctx, setCtx] = useState<TeamsContext | null>(null);
  const [teams, setTeams] = useState<SprayTeam[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([fetchTeamsContext(crop), fetchSprayTeams(crop)])
      .then(([c, t]) => {
        if (!alive) return;
        setCtx(c);
        setTeams(t);
      })
      .catch((e) => alive && setError(e?.message || "Failed to load spray teams"));
    return () => {
      alive = false;
    };
  }, [crop]);

  const onSaved = (t: SprayTeam) =>
    setTeams((prev) => (prev || []).map((x) => (x.name === t.name ? t : x)));

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Personnel · Spray teams" title="Teams" />
      <div className="flex min-w-0 flex-1 flex-col px-4 py-4 md:px-6 md:py-6">
        {ctx && teams ? (
          <SprayTeamsTab teams={teams} ctx={ctx} crop={crop} onSaved={onSaved} />
        ) : error ? (
          <Card>
            <CardContent className="flex items-center justify-center py-12 text-sm text-destructive">
              {error}
            </CardContent>
          </Card>
        ) : (
          <SprayTeamsSkeleton />
        )}
      </div>
    </div>
  );
}
