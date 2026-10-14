import { FilterSelect } from "@/components/FilterSelect";

export interface DashFilters {
  observation: string;
  section: string;
  stage: string;
}

export const ALL_FILTER = "";

export interface DashFilterRowProps {
  obsLabel: string;
  obsOptions: string[];
  sectionOptions: string[];
  stageOptions: string[];
  value: DashFilters;
  onChange: (next: DashFilters) => void;
  /** While the first payload (which carries the options) is loading. */
  disabled?: boolean;
}

/**
 * Three-up filter row used at the top of Pest / Disease trend charts.
 * Mirrors the JS dashboard's pest/section/stage controls, in the same pill
 * dropdowns as every page header (FilterSelect); "All …" stands for "".
 */
export function DashFilterRow({
  obsLabel,
  obsOptions,
  sectionOptions,
  stageOptions,
  value,
  onChange,
  disabled = false,
}: DashFilterRowProps) {
  const set = (k: keyof DashFilters) => (v: string) => onChange({ ...value, [k]: v || ALL_FILTER });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect
        label={obsLabel}
        allLabel={`All ${obsLabel.toLowerCase()}s`}
        value={value.observation}
        onChange={set("observation")}
        options={obsOptions}
        disabled={disabled}
      />
      <FilterSelect
        label="Section"
        allLabel="All sections"
        value={value.section}
        onChange={set("section")}
        options={sectionOptions}
        disabled={disabled}
      />
      <FilterSelect
        label="Stage"
        allLabel="All stages (cumulative)"
        value={value.stage}
        onChange={set("stage")}
        options={stageOptions}
        disabled={disabled}
      />
    </div>
  );
}
