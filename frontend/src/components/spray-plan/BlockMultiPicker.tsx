/**
 * Multi-select block picker for open-field planning: blocks grouped by pivot or
 * section, a select-all per group, a search over block and crop, and each block's
 * crop as a highlighted chip. Handles any number of blocks per group (a pivot has
 * a dozen) by scrolling inside the card.
 */
import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchInput } from "@/components/SearchInput";
import { CropChip } from "@/components/CropChip";
import {
  groupState,
  toggleBlock,
  toggleGroup,
  type OpenFieldBlock,
  type OpenFieldGroup,
} from "@/lib/open-field";

const matches = (b: OpenFieldBlock, q: string) =>
  !q || `${b.label} ${b.name} ${b.crop_label || ""}`.toLowerCase().includes(q);

export function BlockMultiPicker({
  groups,
  selected,
  onChange,
  loading,
}: {
  groups: OpenFieldGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, visible: g.blocks.filter((b) => matches(b, q)) }))
        .filter((g) => g.visible.length),
    [groups, q],
  );

  return (
    <div className="flex flex-col gap-2" data-testid="block-multi-picker">
      <SearchInput value={query} onChange={setQuery} placeholder="Search blocks or crops…" size="md" />
      <div className="max-h-[32rem] overflow-y-auto pr-1">
        {loading ? (
          <div className="flex flex-col gap-2" aria-busy="true" data-skeleton="blocks">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full rounded-md" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {groups.length ? "No block matches." : "No blocks you can plan on. You may not be rostered as a spray plan creator on the farm."}
          </p>
        ) : (
          shown.map((g) => {
            const state = groupState(selected, g.blocks);
            return (
              <section key={g.name ?? "other"} className="mb-3">
                <label className="mb-1 flex cursor-pointer items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  <Checkbox
                    aria-label={`Select all of ${g.label}`}
                    checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
                    onCheckedChange={() => onChange(toggleGroup(selected, g.blocks))}
                  />
                  <span className="flex-1">{g.label}</span>
                  <span className="tabular-nums">
                    {g.blocks.filter((b) => selected.includes(b.name)).length}/{g.blocks.length}
                  </span>
                </label>
                <div className="flex flex-col">
                  {g.visible.map((b) => (
                    <label
                      key={b.name}
                      data-block={b.name}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        aria-label={b.label}
                        checked={selected.includes(b.name)}
                        onCheckedChange={() => onChange(toggleBlock(selected, b.name))}
                      />
                      <span className="flex-1 truncate" title={b.name}>
                        {b.label}
                      </span>
                      <CropChip crop={b.crop_label} />
                    </label>
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
