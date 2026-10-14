/**
 * Asset checks — let scouts fill Asset Check Sheets (from the Upande Asset app)
 * in the Scout app. A master switch plus farm x asset-category rows. The Scout app offers the assets of
 * those categories on those farms, and the scout picks which template to fill.
 *
 * Self-contained (its own load and Save) so the section works the same whether
 * or not Upande Asset is installed; without it the card says so and offers nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, Plus, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/errors";
import {
  fetchAssetCheckSettings,
  saveAssetCheckSettings,
  type AssetCheckRow,
  type AssetCheckSettings,
} from "@/lib/asset-checks-api";

const blankRow = (): AssetCheckRow => ({ farm: "", asset_category: "", enabled: 1 });

export function AssetChecksCard() {
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [data, setData] = useState<AssetCheckSettings | null>(null);
  const [enabled, setEnabled] = useState(0);
  const [rows, setRows] = useState<AssetCheckRow[]>([]);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((s: AssetCheckSettings) => {
    setData(s);
    setEnabled(s.enabled ? 1 : 0);
    setRows(s.rows);
  }, []);

  useEffect(() => {
    fetchAssetCheckSettings().then(apply).catch(() => setData(null));
  }, [apply]);

  if (!data) return null;

  const update = (i: number, patch: Partial<AssetCheckRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const incomplete = rows.some((r) => !r.farm || !r.asset_category);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      apply(await saveAssetCheckSettings({ enabled, rows }));
      setMsg({ text: "Asset check settings saved.", ok: true });
    } catch (e) {
      setMsg({ text: errorText(e), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          Asset checks
        </CardTitle>
        <CardDescription>
          Scouts fill asset check sheets in the Scout app, on the farms and
          asset categories listed here, choosing the template themselves.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!data.installed ? (
          <p className="text-sm text-muted-foreground">
            The Upande Asset app is not installed on this site, so asset checks
            are unavailable. Nothing here has any effect until it is.
          </p>
        ) : (
          <>
            <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
              <Checkbox
                id="asset_checks_enabled"
                checked={enabled !== 0}
                onCheckedChange={(v) => setEnabled(v ? 1 : 0)}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor="asset_checks_enabled" className="text-xs font-semibold cursor-pointer">
                  Scouts fill asset check sheets
                </Label>
                <p className="text-[0.65rem] text-muted-foreground leading-snug">
                  Master switch. Off, the Scout app shows no asset checks at all.
                </p>
              </div>
            </div>

            {enabled !== 0 && (
              <div className="flex flex-col gap-2">
                {rows.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No farm has an asset category yet. Add one to start.
                  </p>
                )}
                {rows.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
                    <select
                      aria-label="Farm"
                      className="h-9 rounded-md border bg-background px-2 text-xs"
                      value={r.farm}
                      onChange={(e) => update(i, { farm: e.target.value })}
                    >
                      <option value="">Farm...</option>
                      {data.farms.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Asset category"
                      className="h-9 rounded-md border bg-background px-2 text-xs"
                      value={r.asset_category}
                      onChange={(e) => update(i, { asset_category: e.target.value })}
                    >
                      <option value="">Asset category...</option>
                      {data.categories.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                    <div className="ml-auto flex items-center gap-3">
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <Checkbox
                          checked={r.enabled !== 0}
                          onCheckedChange={(v) => update(i, { enabled: v ? 1 : 0 })}
                        />
                        On
                      </label>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Remove row"
                        onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <div>
                  <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, blankRow()])}>
                    <Plus className="h-4 w-4 mr-1" /> Add farm and category
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={save} disabled={busy || incomplete}>
                {busy ? "Saving..." : "Save asset checks"}
              </Button>
              {msg && (
                <span className={`text-xs ${msg.ok ? "text-emerald-600" : "text-destructive"}`}>{msg.text}</span>
              )}
              {incomplete && (
                <span className="text-xs text-muted-foreground">
                  Pick a farm and an asset category on every row.
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default AssetChecksCard;
