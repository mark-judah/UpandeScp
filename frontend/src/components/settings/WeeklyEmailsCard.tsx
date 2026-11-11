/**
 * Weekly report emails whose send day the GM picks: the spray records email
 * and the avocado scout coverage email. Each has an on/off switch and a weekday
 * (Monday to Sunday). The scheduler wakes once a day and sends an email when
 * today is its day. Saved with the rest of the tab.
 */
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FilterSelect } from "@/components/FilterSelect";

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface WeeklyEmailsValue {
  spray_records_email_enabled?: number;
  spray_records_email_day?: string;
  avocado_scout_email_enabled?: number;
  avocado_scout_email_day?: string;
}

const ROWS = [
  {
    key: "spray_records",
    title: "Weekly spray records email",
    hint: "Per farm: each location, active ingredient and product sprayed last week, with the number of applications, quantity and last date, and a workbook. To the farm managers and the GM.",
  },
  {
    key: "avocado_scout",
    title: "Weekly avocado scout coverage email",
    hint: "To the avocado teams only: per scout the trees scouted, entries, blocks, active days and distance walked, and the blocks not scouted that week.",
  },
] as const;

export function WeeklyEmailsCard({
  value,
  onChange,
}: {
  value: WeeklyEmailsValue;
  onChange: (patch: WeeklyEmailsValue) => void;
}) {
  const v = value as Record<string, number | string | undefined>;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Weekly report emails</CardTitle>
        <CardDescription>
          Each goes out once a week, on the day chosen here, for the week just ended.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ROWS.map((r) => {
          const en = `${r.key}_email_enabled`;
          const day = `${r.key}_email_day`;
          const on = v[en] === undefined ? true : !!v[en];
          return (
            <div key={r.key} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  id={en}
                  checked={on}
                  onCheckedChange={(c) => onChange({ [en]: c ? 1 : 0 })}
                />
                <div className="flex flex-col gap-1">
                  <Label htmlFor={en} className="text-xs font-semibold cursor-pointer">
                    {r.title}
                  </Label>
                  <p className="text-[0.65rem] text-muted-foreground leading-snug">{r.hint}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-7">
                <Label className="text-[0.7rem]">Send on</Label>
                <FilterSelect
                  label={`${r.title} day`}
                  value={(v[day] as string) || "Monday"}
                  onChange={(d) => onChange({ [day]: d })}
                  options={WEEKDAYS}
                  disabled={!on}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
