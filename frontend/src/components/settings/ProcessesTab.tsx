/**
 * Processes Settings — operational process choices the General Manager controls.
 * Currently: the CSU scan-verification method (scan the label/QR vs tick to
 * confirm). The mobile app reads this and shows a scan or a tick control
 * accordingly; the server enforces it on register_csu_scan.
 */

import { useMemo, useState } from "react";
import { Loader2, Save, ScanLine, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveSprayPlanSettings,
  type SprayPlanSettings,
} from "@/lib/settings-api";
import { FrappeError } from "@/lib/frappe";

interface Props {
  initial: SprayPlanSettings;
  onSaved?: (saved: SprayPlanSettings) => void;
}

const SCAN_LABELS = "Scan Labels";
const TICK = "Tick Confirmation";

export function ProcessesTab({ initial, onSaved }: Props) {
  const [draft, setDraft] = useState<SprayPlanSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const method = draft.scan_verification_method || SCAN_LABELS;
  const dirty = useMemo(
    () =>
      (draft.scan_verification_method || SCAN_LABELS) !==
      (initial.scan_verification_method || SCAN_LABELS),
    [draft.scan_verification_method, initial.scan_verification_method],
  );

  const setMethod = (value: string) => {
    setDraft((d) => ({ ...d, scan_verification_method: value }));
    setOk(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      await saveSprayPlanSettings(draft);
      setOk(true);
      onSaved?.(draft);
    } catch (e) {
      setError(e instanceof FrappeError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ScanLine className="h-4 w-4" />
            Chemical scan verification
          </CardTitle>
          <CardDescription>
            How operators confirm each chemical at the CSU on the mobile app.
            Switching to “Scan Labels” forces operators to scan the QR/label;
            “Tick Confirmation” lets them tick to confirm instead. The change is
            enforced server-side — a stale app cannot tick when scanning is
            required.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 max-w-md">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scan_verification_method">Verification method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="scan_verification_method" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SCAN_LABELS}>
                  Scan Labels (scan the QR / label)
                </SelectItem>
                <SelectItem value={TICK}>
                  Tick Confirmation (tick instead of scanning)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-2 rounded-lg border bg-card p-3 text-[0.7rem] text-muted-foreground leading-snug">
            {method === TICK ? (
              <CheckSquare className="h-3.5 w-3.5 mt-[1px] shrink-0 text-[var(--sd-data-green)]" />
            ) : (
              <ScanLine className="h-3.5 w-3.5 mt-[1px] shrink-0 text-[var(--sd-data-cyan)]" />
            )}
            <span>
              {method === TICK
                ? "Operators will see a tick control on the scan screen; ticking records the chemical as scanned."
                : "Operators must scan each chemical’s QR/label; ticking is rejected by the server."}
            </span>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button onClick={save} disabled={!dirty || saving} className="gap-2">
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save
            </Button>
            {ok && (
              <span className="text-xs text-[var(--sd-data-green)]">Saved.</span>
            )}
            {error && (
              <span className="text-xs text-destructive">{error}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
