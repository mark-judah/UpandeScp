/**
 * Multi-select for the pests and diseases a map shows. Renders the shared
 * TreePicker (the Trends look): a pill with a sparkle icon, a searchable tree of
 * "Pests" and "Diseases" groups (each follows its items) with colour swatches
 * and counts, circular check dots, one header row with "N selected",
 * expand/collapse-all and Select all / Deselect all.
 *
 * The pill reads "All pests and diseases", the single name, or "3 selected".
 * `value` holds the selected keys (`kind|name`); `onChange` gets the new set.
 */
import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { TreePicker } from "@/components/TreePicker";
import { useObservationColors } from "@/lib/observation-colors";
import type { ObsOption } from "@/lib/pest-heat";
import type { TreeNode } from "@/pages/trends/trends-types";

export const obsOptionKey = (o: { kind: string; name: string }) => `${o.kind}|${o.name}`;

const GROUPS: Array<{ kind: "pest" | "disease"; label: string }> = [
  { kind: "pest", label: "Pests" },
  { kind: "disease", label: "Diseases" },
];

export function pillText(options: ObsOption[], value: ReadonlySet<string>): string {
  const sel = options.filter((o) => value.has(obsOptionKey(o)));
  if (!options.length) return "No observations";
  if (!sel.length) return "None selected";
  if (sel.length === options.length) {
    const kinds = new Set(options.map((o) => o.kind));
    if (options.length === 1) return options[0].name;
    return kinds.size === 2 ? "All pests and diseases" : kinds.has("pest") ? "All pests" : "All diseases";
  }
  return sel.length === 1 ? sel[0].name : `${sel.length} selected`;
}

export function ObservationMultiPicker({
  options,
  value,
  onChange,
  className,
}: {
  options: ObsOption[];
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  className?: string;
}) {
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();
  const colorOf = (o: ObsOption) => (o.kind === "pest" ? pestColor(o.name) : diseaseColor(o.name));

  const nodes = useMemo<TreeNode[]>(
    () =>
      GROUPS.flatMap((g) => {
        const items = options.filter((o) => o.kind === g.kind);
        if (!items.length) return [];
        return [
          {
            id: `g:${g.kind}`,
            label: g.label,
            count: items.reduce((n, o) => n + (o.count || 0), 0),
            children: items.map((o) => ({
              id: `i:${obsOptionKey(o)}`,
              label: o.name,
              count: o.count,
              lead: (
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border"
                  style={{ background: colorOf(o) }}
                  aria-hidden
                />
              ),
            })),
          },
        ];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, pestColor, diseaseColor],
  );

  const checked = useMemo(
    () => new Set(options.filter((o) => value.has(obsOptionKey(o))).map((o) => `i:${obsOptionKey(o)}`)),
    [options, value],
  );

  return (
    <TreePicker
      label="Pests and diseases"
      ariaLabel="Pests and diseases"
      valueText={pillText(options, value)}
      icon={<Sparkles className="h-3.5 w-3.5 shrink-0" />}
      disabled={!options.length}
      className={className}
      nodes={nodes}
      checked={checked}
      cascade
      childNoun="observation"
      onChange={(next) => onChange(new Set([...next].map((id) => id.slice(2))))}
      emptyHint="No observations"
      searchPlaceholder="Search pests and diseases"
    />
  );
}
