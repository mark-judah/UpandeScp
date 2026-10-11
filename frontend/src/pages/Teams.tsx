/**
 * Teams & KPIs — scouting KPIs, the spray teams of the user's farms, and the
 * sprayer register with each person's chemical exposure.
 *
 * Server: serverscripts/sprayers/api.py. A General Manager / System Manager
 * acts on every farm they can see; an SCP Spray Supervisor only on the farms
 * they are rostered on. The page never decides that itself — it shows what the
 * server returns and surfaces its refusals.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScoutingKpisTab } from "@/components/teams/ScoutingKpisTab";
import { SprayTeamsTab } from "@/components/teams/SprayTeamsTab";
import { SprayersTab } from "@/components/teams/SprayersTab";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import {
  fetchSprayers,
  fetchSprayTeams,
  fetchTeamsContext,
  type SprayersPayload,
  type SprayTeam,
  type TeamsContext,
} from "@/lib/teams-api";

type TabId = "kpis" | "teams" | "sprayers";

function Pending({ error }: { error: string | null }) {
  return (
    <Card>
      <CardContent
        className={`flex items-center justify-center py-12 text-sm ${error ? "text-destructive" : "text-muted-foreground"}`}
      >
        {error ? error : (<><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…</>)}
      </CardContent>
    </Card>
  );
}

export function Teams({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const [tab, setTab] = useState<TabId>("teams");
  const [ctx, setCtx] = useState<TeamsContext | null>(null);
  const [teams, setTeams] = useState<SprayTeam[] | null>(null);
  const [sprayers, setSprayers] = useState<SprayersPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSprayers = useCallback(() => {
    fetchSprayers(crop)
      .then(setSprayers)
      .catch((e) => setError(e?.message || "Failed to load sprayers"));
  }, [crop]);

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
    loadSprayers();
    return () => {
      alive = false;
    };
  }, [crop, loadSprayers]);

  const onSaved = (t: SprayTeam) => {
    setTeams((prev) => (prev || []).map((x) => (x.name === t.name ? t : x)));
    // Saving re-syncs the members into the register: refresh it.
    loadSprayers();
  };

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Scouting · Spray teams · Exposure" title="Teams & KPIs" />
      <div className="flex min-w-0 flex-1 flex-col px-4 py-4 md:px-6 md:py-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex flex-col gap-4">
          <TabsList className="self-start">
            <TabsTrigger value="kpis">Scouting KPIs</TabsTrigger>
            <TabsTrigger value="teams">Spray teams</TabsTrigger>
            <TabsTrigger value="sprayers">Sprayers</TabsTrigger>
          </TabsList>
          <TabsContent value="kpis" className="mt-0">
            <ScoutingKpisTab crop={crop} active={tab === "kpis"} />
          </TabsContent>
          <TabsContent value="teams" className="mt-0">
            {ctx && teams ? (
              <SprayTeamsTab teams={teams} ctx={ctx} crop={crop} onSaved={onSaved} />
            ) : (
              <Pending error={error} />
            )}
          </TabsContent>
          <TabsContent value="sprayers" className="mt-0">
            {sprayers ? <SprayersTab data={sprayers} crop={crop} /> : <Pending error={error} />}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
