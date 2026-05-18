import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
export interface DashFilters {
  observation: string;
  section: string;
  stage: string;
}

export const ALL_FILTER = "";

const ALL_TOKEN = "__all__";

export interface DashFilterRowProps {
  obsLabel: string;
  obsOptions: string[];
  sectionOptions: string[];
  stageOptions: string[];
  value: DashFilters;
  onChange: (next: DashFilters) => void;
}

/**
 * Three-up filter row used at the top of Pest / Disease trend charts.
 * Mirrors the JS dashboard's pest/section/stage controls. The empty
 * sentinel ("All …") is mapped to/from ``""`` because shadcn Select
 * doesn't allow an empty string ``value``.
 */
export function DashFilterRow({
  obsLabel,
  obsOptions,
  sectionOptions,
  stageOptions,
  value,
  onChange,
}: DashFilterRowProps) {
  const set = (k: keyof DashFilters) => (v: string) =>
    onChange({ ...value, [k]: v === ALL_TOKEN ? ALL_FILTER : v });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1 min-w-40">
        <Label>{obsLabel}</Label>
        <Select
          value={value.observation || ALL_TOKEN}
          onValueChange={set("observation")}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TOKEN}>All {obsLabel.toLowerCase()}s</SelectItem>
            {obsOptions.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1 min-w-32">
        <Label>Section</Label>
        <Select value={value.section || ALL_TOKEN} onValueChange={set("section")}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TOKEN}>All sections</SelectItem>
            {sectionOptions.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1 min-w-32">
        <Label>Stage</Label>
        <Select value={value.stage || ALL_TOKEN} onValueChange={set("stage")}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TOKEN}>All stages (cumulative)</SelectItem>
            {stageOptions.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
