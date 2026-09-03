/**
 * Accounts tab — where spray spend lands in the GL.
 *
 * Two things live here:
 *
 *   • Cost centre attribution. A spray plan resolves its own cost centre when
 *     it is created (the greenhouse, or the operator's override) and stores it
 *     on the Work Order. Chemical Mixing and Chemical Spray have always read it
 *     back; the CSU Chemical Transfer did not, because ERPNext builds that entry
 *     itself and knows nothing about the field. The toggle closes that gap.
 *
 *   • The account overrides that were previously editable in Desk only.
 */

import { useMemo, useState } from "react";
import { Landmark, Loader2, Save, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  saveSprayPlanSettings,
  type SprayPlanSettings,
} from "@/lib/settings-api";

import { errorText } from "@/lib/errors";
interface Props {
  initial: SprayPlanSettings;
  onSaved?: (saved: SprayPlanSettings) => void;
}

export function AccountsTab({ initial, onSaved }: Props) {
  const [draft, setDraft] = useState<SprayPlanSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const set = <K extends keyof SprayPlanSettings>(
    key: K,
    value: SprayPlanSettings[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setOk(false);
  };

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initial),
    [draft, initial],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    setOk(false);
    try {
      await saveSprayPlanSettings(draft);
      setOk(true);
      onSaved?.(draft);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Scale className="h-4 w-4" />
            Cost centre attribution
          </CardTitle>
          <CardDescription>
            Which cost centre the chemicals for a spray plan are charged to.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
            <Checkbox
              id="stamp_transfer_cost_center"
              checked={!!draft.stamp_transfer_cost_center}
              onCheckedChange={(v) =>
                set("stamp_transfer_cost_center", v ? 1 : 0)
              }
            />
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="stamp_transfer_cost_center"
                className="text-xs font-semibold cursor-pointer"
              >
                Stamp the greenhouse cost centre on CSU Chemical Transfers
              </Label>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                On, every chemical moved from the store to a CSU is charged to
                the plan's own cost centre — the greenhouse — so spend splits
                the same way Chemical Mixing and Chemical Spray already do.
              </p>
              <p className="text-[0.65rem] text-muted-foreground leading-snug">
                Off, the transfer falls back to ERPNext's own chain: the item's
                default buying cost centre, then the company default. If both
                are blank the transfer cannot be saved at all — it is refused
                with <em>Cost Center is mandatory for Item …</em>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Landmark className="h-4 w-4" />
            Material issue defaults
          </CardTitle>
          <CardDescription>
            Fallbacks used when an item carries no default of its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <Acct
            label="Default Chemical Expense Account"
            value={draft.default_chemical_expense_account}
            onChange={(v) => set("default_chemical_expense_account", v)}
            placeholder="e.g. Chemical Expenses - KR"
            help="Used by the auto Material Issue when the tank-mix item has no Item Default for the plan's company."
          />
          <Acct
            label="Default Chemical Difference Account"
            value={draft.default_chemical_difference_account}
            onChange={(v) => set("default_chemical_difference_account", v)}
            placeholder="e.g. Stock Adjustment - KR"
            help="Written as the Difference Account on the Manufacture Stock Entry created when the tank mix is manufactured."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Landmark className="h-4 w-4" />
            Stock accounting — mixing &amp; spray
          </CardTitle>
          <CardDescription>
            Leave blank to use the warehouse accounts. Set one only to override.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <Acct
            label="Raw Chemical Account (credited on Mixing)"
            value={draft.spray_raw_chemical_account}
            onChange={(v) => set("spray_raw_chemical_account", v)}
            placeholder="blank = source warehouse account"
            help="Overrides the raw-consumption credit when the tank mix is manufactured."
          />
          <Acct
            label="Tank-Mix / WIP Account"
            value={draft.spray_tank_mix_account}
            onChange={(v) => set("spray_tank_mix_account", v)}
            placeholder="blank = CSU / WIP warehouse account"
            help="Shared account: the tank mix's value goes in on Mixing (including any valuation difference) and out again on Spray."
          />
          <Acct
            label="Spray Expense Account (debited on Spray)"
            value={draft.spray_expense_account}
            onChange={(v) => set("spray_expense_account", v)}
            placeholder="blank = default chemical expense account"
            help="The P&L expense the spray is charged to. Falls back to the default chemical expense account, then the item's own."
          />
        </CardContent>
      </Card>

      <div className="lg:col-span-2 flex items-center justify-end gap-3 pt-1">
        {error && (
          <span className="text-xs text-destructive max-w-sm text-right">
            {error}
          </span>
        )}
        {ok && !dirty && (
          <span className="text-xs text-emerald-600 font-medium">Saved.</span>
        )}
        <Button onClick={save} disabled={!dirty || saving} size="lg">
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save settings
        </Button>
      </div>
    </div>
  );
}

function Acct({
  label,
  value,
  onChange,
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  help: string;
}) {
  return (
    <div>
      <Label className="text-[0.7rem]">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9"
      />
      <p className="mt-1 text-[0.65rem] text-muted-foreground leading-snug">
        {help}
      </p>
    </div>
  );
}
