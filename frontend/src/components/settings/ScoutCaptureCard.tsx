/**
 * Scouting capture (pieces 5–6): what a scout may record beyond the counts,
 * and the highest count one observation may carry. The scout app reads all
 * three with its observations (getObservationsDetails → `capture`); switched
 * off, the camera or the Comments tab is not drawn at all rather than drawn
 * and refused. Saved with the rest of the Spray plan tab.
 */

import { Camera } from "lucide-react";
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

export const MAX_COUNT_MIN = 1;
export const MAX_COUNT_MAX = 10000;

export interface ScoutCaptureValues {
  allow_scout_photos: number;
  allow_scout_comments: number;
  max_count_per_observation: number;
}

/** The server's rule, checked here first so a bad value never leaves the page. */
export function maxCountError(value: number): string | null {
  return Number.isInteger(value) && value >= MAX_COUNT_MIN && value <= MAX_COUNT_MAX
    ? null
    : "Max count must be a whole number from 1 to 10000.";
}

export function ScoutCaptureCard({
  value,
  onChange,
}: {
  value: ScoutCaptureValues;
  onChange: (key: keyof ScoutCaptureValues, value: number) => void;
}) {
  const error = maxCountError(value.max_count_per_observation);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Camera className="h-4 w-4 text-muted-foreground" />
          Scouting capture
        </CardTitle>
        <CardDescription>
          What a scout may record on a round beyond the counts. The app reads
          these when it loads its observations.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <Checkbox
            id="allow_scout_photos"
            checked={value.allow_scout_photos !== 0}
            onCheckedChange={(v) => onChange("allow_scout_photos", v ? 1 : 0)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow_scout_photos" className="text-xs font-semibold cursor-pointer">
              Scouts can attach photos
            </Label>
            <p className="text-[0.65rem] text-muted-foreground leading-snug">
              One photo button per finding the scout records, plus a General
              photo, each with its own caption, up to 5 per entry. A photo of
              something unidentified on a trap is always accepted.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
          <Checkbox
            id="allow_scout_comments"
            checked={value.allow_scout_comments !== 0}
            onCheckedChange={(v) => onChange("allow_scout_comments", v ? 1 : 0)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="allow_scout_comments" className="text-xs font-semibold cursor-pointer">
              Scouts can write comments
            </Label>
            <p className="text-[0.65rem] text-muted-foreground leading-snug">
              A free-text note on the entry. Off: the Comments tab does not
              appear in the app.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
          <Label htmlFor="max_count_per_observation" className="text-xs font-semibold">
            Max count per observation
          </Label>
          <Input
            id="max_count_per_observation"
            type="number"
            min={MAX_COUNT_MIN}
            max={MAX_COUNT_MAX}
            step={1}
            value={Number.isFinite(value.max_count_per_observation) ? value.max_count_per_observation : ""}
            onChange={(e) =>
              onChange(
                "max_count_per_observation",
                e.target.value === "" ? Number.NaN : Number(e.target.value),
              )
            }
            aria-invalid={error ? true : undefined}
            className="h-9 w-32 tabular-nums"
          />
          <p
            className={
              error
                ? "text-[0.65rem] text-destructive leading-snug"
                : "text-[0.65rem] text-muted-foreground leading-snug"
            }
          >
            {error ?? "The highest count the app accepts for one observation or one trap pest. 15 until changed."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
