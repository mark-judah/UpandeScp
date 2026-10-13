/**
 * Traps: a "Photo required" switch per trap pest, separate from the general
 * "Scouts can attach photos" switch. The scout app reads the pests that need
 * one with its observations (capture.trap_photo_required). A pest with no
 * switch on is not required.
 */

import { Bug } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export interface TrapPhotoRule {
  pest: string;
  photo_required: number;
}

/** The pests to list: everything a trap has caught plus any pest already ruled on. */
export function trapPestRows(pests: string[], rules: TrapPhotoRule[]): TrapPhotoRule[] {
  const on = new Map(rules.map((r) => [r.pest, r.photo_required]));
  const names = Array.from(new Set([...pests, ...rules.map((r) => r.pest)])).sort((a, b) => a.localeCompare(b));
  return names.map((pest) => ({ pest, photo_required: on.get(pest) ? 1 : 0 }));
}

/** Rules with `pest` switched; rows that are off and were never ruled on are not stored. */
export function withRule(rules: TrapPhotoRule[], pest: string, required: boolean): TrapPhotoRule[] {
  const rest = rules.filter((r) => r.pest !== pest);
  return required || rules.some((r) => r.pest === pest)
    ? [...rest, { pest, photo_required: required ? 1 : 0 }]
    : rest;
}

export function TrapPhotoCard({
  pests,
  rules,
  onChange,
}: {
  pests: string[];
  rules: TrapPhotoRule[];
  onChange: (rules: TrapPhotoRule[]) => void;
}) {
  const rows = trapPestRows(pests, rules);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bug className="h-4 w-4 text-muted-foreground" />
          Traps
        </CardTitle>
        <CardDescription>
          Per trap pest: a scout must photograph a catch of it before saving the
          trap. Independent of the general photo switch above.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No trap pests yet.</p>
        ) : null}
        {rows.map((r) => {
          const id = `trap_photo_${r.pest}`;
          return (
            <div key={r.pest} className="flex items-center gap-3 rounded-lg border bg-card p-3">
              <Checkbox
                id={id}
                checked={r.photo_required !== 0}
                onCheckedChange={(v) => onChange(withRule(rules, r.pest, Boolean(v)))}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={id} className="cursor-pointer truncate text-xs font-semibold">
                  {r.pest}
                </Label>
                <span className="text-[0.65rem] text-muted-foreground">Photo required</span>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
