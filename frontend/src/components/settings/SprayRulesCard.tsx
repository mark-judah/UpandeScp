/**
 * Settings -> Spray Plan -> spray check rules. Each rule is Off, Warn, Block
 * (GM override) or Block; a crop may differ from the site default.
 */
import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorText } from "@/lib/errors";
import {
  getRuleModes,
  getTargetingMode,
  ruleLabel,
  setRuleModes,
  setTargetingMode,
  type RuleMode,
  type RuleModes,
  type TargetingMode,
  type TargetingModeInfo,
} from "@/lib/spray-compliance-api";

export function SprayRulesCard({ crop = "" }: { crop?: string }) {
  const [data, setData] = useState<RuleModes | null>(null);
  const [draft, setDraft] = useState<Record<string, RuleMode>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [targeting, setTargeting] = useState<TargetingModeInfo | null>(null);

  // The site-wide mode is not per crop, so it shows only on the site-level card.
  useEffect(() => {
    if (crop) return;
    getTargetingMode().then(setTargeting).catch(() => undefined);
  }, [crop]);
  const changeTargeting = async (m: TargetingMode) => {
    setError("");
    try {
      setTargeting(await setTargetingMode(m));
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    let off = false;
    setData(null);
    getRuleModes(crop)
      .then((d) => {
        if (off) return;
        setData(d);
        setDraft(Object.fromEntries(d.rules.map((r) => [r.rule, r.mode])));
      })
      .catch((e) => !off && setError(errorText(e)));
    return () => {
      off = true;
    };
  }, [crop]);

  const dirty = !!data && data.rules.some((r) => draft[r.rule] !== r.mode);
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const d = await setRuleModes(draft, crop);
      setData(d);
      setDraft(Object.fromEntries(d.rules.map((r) => [r.rule, r.mode])));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Spray check rules{crop ? ` — ${crop}` : ""}</CardTitle>
        <CardDescription>
          Warn shows a warning; Block (GM override) needs a General Manager reason; Block refuses the plan.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {!crop && targeting ? (
          <div className="mb-2 flex flex-col gap-1 border-b pb-3" data-testid="targeting-mode">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium">Chemical targeting enforcement</span>
              <Select
                value={targeting.mode}
                onValueChange={(v) => void changeTargeting(v as TargetingMode)}
                disabled={!targeting.can_edit}
              >
                <SelectTrigger aria-label="Chemical targeting enforcement" className="w-48 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targeting.modes.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              <b>Strict</b>: every chemical must be assigned a pest or disease it is registered or known to work on,
              and the rules below apply as configured.
            </p>
            <p className="text-xs text-muted-foreground">
              <b>Warn</b>: any chemical may be picked (each still needs a pest or disease); targeting and rotation
              rules only warn, so the floor plan never stops operations.
            </p>
          </div>
        ) : null}
        {!data ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          data.rules.map((r) => (
            <div key={r.rule} className="flex items-center justify-between gap-3 text-xs">
              <span>
                {ruleLabel(r.rule)}
                {crop && r.overridden ? <span className="ml-1 text-muted-foreground">(differs from site)</span> : null}
              </span>
              <Select value={draft[r.rule]} onValueChange={(v) => setDraft((d) => ({ ...d, [r.rule]: v as RuleMode }))}>
                <SelectTrigger className="w-48 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.modes.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))
        )}
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save rules
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
