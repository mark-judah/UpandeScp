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
import { getRuleModes, ruleLabel, setRuleModes, type RuleMode, type RuleModes } from "@/lib/spray-compliance-api";

export function SprayRulesCard({ crop = "" }: { crop?: string }) {
  const [data, setData] = useState<RuleModes | null>(null);
  const [draft, setDraft] = useState<Record<string, RuleMode>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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
