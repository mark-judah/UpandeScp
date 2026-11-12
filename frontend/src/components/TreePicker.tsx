/**
 * THE multi-select picker for hierarchical lists (farms → greenhouses,
 * observations → pests/diseases): a header pill that opens a searchable tree.
 *
 * - Circular dots, not squares: empty ring = unselected, filled dot with a
 *   check = selected, half-filled dot = some of a group's children selected.
 *   Each is a `role="checkbox"` with `aria-checked` ("mixed" for the half dot).
 * - One header row that never wraps: "N selected" · expand/collapse-all icons ·
 *   a single Select all ↔ Deselect all toggle.
 * - Selecting a group row selects the group's own id only (an aggregate);
 *   the compact icons on a group row select / clear every child.
 * - `cascade`: a group is derived from its leaves (all = checked, some = half)
 *   and toggling it toggles every leaf; `checked` then holds leaf ids only.
 * - `single`: radio-like. Picking a row replaces the selection and closes the
 *   popover; no Select all, no group icons, radio dots. A node with
 *   `selectable: false` is a plain header that only expands.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, ChevronsDownUp, ChevronsUpDown, CircleCheck, CircleX, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_PILL } from "@/components/header-controls";
import { SearchInput } from "@/components/SearchInput";
import { cn } from "@/lib/utils";
import { matchesQuery } from "@/lib/places";
import type { CheckState, TreeNode } from "@/pages/trends/trends-types";

export type TreePickerPanelProps = {
  nodes: TreeNode[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyHint?: string;
  searchPlaceholder?: string;
  /** one choice at a time (see the header comment) */
  single?: boolean;
  /** groups follow their leaves; `checked` holds leaf ids only */
  cascade?: boolean;
  /** what a group's children are called, in the group icons' tooltips */
  childNoun?: string;
  /** called after a single-mode pick (the popover closes on it) */
  onPick?: () => void;
};

function collectLeafIds(node: TreeNode): string[] {
  if (!node.children?.length) return [node.id];
  return node.children.flatMap(collectLeafIds);
}

function nodeState(node: TreeNode, checked: Set<string>, cascade = false): CheckState {
  if (cascade && node.children?.length) {
    const leaves = collectLeafIds(node);
    const n = leaves.filter((id) => checked.has(id)).length;
    return n === 0 ? "unchecked" : n === leaves.length ? "checked" : "indeterminate";
  }
  if (checked.has(node.id)) return "checked";
  // Surface a hint when a parent isn't itself selected but some descendants are.
  if (node.children?.some((c) => nodeState(c, checked, cascade) !== "unchecked")) return "indeterminate";
  return "unchecked";
}

/** The circular checkbox. Rendered inside a clickable row, so a click or
 *  Space/Enter on it bubbles to the row's toggle. */
export function Dot({ state, label, radio }: { state: CheckState; label: string; radio?: boolean }) {
  return (
    <button
      type="button"
      role={radio ? "radio" : "checkbox"}
      aria-checked={state === "checked" ? true : state === "indeterminate" ? "mixed" : false}
      aria-label={label}
      data-state={state}
      className={cn(
        "relative flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        state === "unchecked" && "border-input bg-background",
        state === "checked" && "border-primary bg-primary text-primary-foreground",
        state === "indeterminate" && "border-primary bg-background",
      )}
    >
      {state === "checked" && (radio ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : <Check className="h-2.5 w-2.5" strokeWidth={3} />)}
      {state === "indeterminate" && <span className="absolute inset-y-0 left-0 w-1/2 bg-primary" />}
    </button>
  );
}

function IconAction({
  label, onClick, children, className,
}: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TreePickerPanel({
  nodes,
  checked,
  onChange,
  emptyHint = "No items in range.",
  searchPlaceholder = "Search…",
  single = false,
  cascade = false,
  childNoun = "greenhouse",
  onPick,
}: TreePickerPanelProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(nodes.map((n) => n.id)));

  const filteredIds = useMemo(() => {
    if (!query.trim()) return null;
    const visible = new Set<string>();
    const walk = (n: TreeNode): boolean => {
      // Case and spaces ignored, as in the place picker ("gh16", "chep 16").
      const self = matchesQuery(n.search ?? n.label, query);
      const childMatch = (n.children || []).map(walk).some(Boolean);
      if (self || childMatch) {
        visible.add(n.id);
        return true;
      }
      return false;
    };
    nodes.forEach(walk);
    return visible;
  }, [nodes, query]);

  const allLeafIds = useMemo(() => nodes.flatMap(collectLeafIds), [nodes]);
  const allSelected = allLeafIds.length > 0 && allLeafIds.every((id) => checked.has(id));
  const selectedCount = cascade ? allLeafIds.filter((id) => checked.has(id)).length : checked.size;

  const groupIds = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TreeNode) => {
      if (n.children?.length) {
        out.push(n.id);
        n.children.forEach(walk);
      }
    };
    nodes.forEach(walk);
    return out;
  }, [nodes]);
  const allExpanded = groupIds.length > 0 && groupIds.every((id) => expanded.has(id));

  const toggleOpen = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleNode = (n: TreeNode) => {
    if (n.selectable === false) return toggleOpen(n.id);
    if (single) {
      onChange(new Set([n.id]));
      onPick?.();
      return;
    }
    if (cascade && n.children?.length) {
      const leaves = collectLeafIds(n);
      const all = leaves.every((id) => checked.has(id));
      const next = new Set(checked);
      leaves.forEach((id) => (all ? next.delete(id) : next.add(id)));
      onChange(next);
      return;
    }
    // Non-cascading: a parent toggles its own id only (an aggregate selection).
    const next = new Set(checked);
    if (next.has(n.id)) next.delete(n.id);
    else next.add(n.id);
    onChange(next);
  };
  const toggleAll = () => onChange(allSelected ? new Set() : new Set(allLeafIds));
  const selectSubtree = (n: TreeNode) => {
    const next = new Set(checked);
    collectLeafIds(n).forEach((id) => next.add(id));
    onChange(next);
  };
  const unselectSubtree = (n: TreeNode) => {
    const next = new Set(checked);
    collectLeafIds(n).forEach((id) => next.delete(id));
    next.delete(n.id);
    onChange(next);
  };
  const expandAll = (open: boolean) => {
    if (!open) return setExpanded(new Set());
    const all = new Set<string>();
    const walk = (n: TreeNode) => {
      if (n.children?.length) {
        all.add(n.id);
        n.children.forEach(walk);
      }
    };
    nodes.forEach(walk);
    setExpanded(all);
  };

  const renderNode = (n: TreeNode, depth: number): ReactNode => {
    if (filteredIds && !filteredIds.has(n.id)) return null;
    const selectable = n.selectable !== false;
    const state = single ? (checked.has(n.id) ? "checked" : "unchecked") : nodeState(n, checked, cascade);
    const open = expanded.has(n.id);
    const hasChildren = !!n.children?.length;
    const leafIds = hasChildren ? collectLeafIds(n) : [];
    const anyLeaf = leafIds.some((id) => checked.has(id));
    return (
      <div key={n.id} style={{ paddingLeft: depth * 14 }}>
        <div
          data-row={n.id}
          className={cn(
            "group flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-muted/60",
            state === "checked" && "bg-muted/40",
          )}
          onClick={() => toggleNode(n)}
        >
          {hasChildren ? (
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} ${n.label}`}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                toggleOpen(n.id);
              }}
              className="flex h-4 w-4 items-center justify-center text-muted-foreground"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
            </button>
          ) : (
            <span className="w-4" />
          )}
          {selectable && <Dot state={state} label={n.label} radio={single} />}
          {n.lead}
          <span
            className={cn("flex-1 truncate text-sm", !selectable && "text-[11px] font-semibold text-muted-foreground")}
            title={n.title ?? n.search}
          >
            {n.label}
          </span>
          {n.extra}
          {hasChildren && !single && selectable && (
            <span className="flex items-center opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <IconAction label={`Select every ${childNoun} in ${n.label}`} onClick={() => selectSubtree(n)}>
                <ListChecks className="h-3.5 w-3.5" />
              </IconAction>
              {(anyLeaf || checked.has(n.id)) && (
                <IconAction
                  label={`Clear ${n.label}`}
                  onClick={() => unselectSubtree(n)}
                  className="text-[var(--sd-data-red)] hover:text-[var(--sd-data-red)]"
                >
                  <CircleX className="h-3.5 w-3.5" />
                </IconAction>
              )}
            </span>
          )}
          {typeof n.count === "number" && (
            <span className="text-[0.7rem] tabular-nums text-muted-foreground">{n.count}</span>
          )}
        </div>
        {hasChildren && open && <div>{n.children!.map((c) => renderNode(c, depth + 1))}</div>}
      </div>
    );
  };

  if (!nodes.length) {
    return <div className="p-3 text-xs text-muted-foreground">{emptyHint}</div>;
  }

  /** Enter in the search box acts on the best match: the first visible, selectable
   *  row whose own text matches (a farm shown only as context of a matching house is skipped). */
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !query.trim()) return;
    e.preventDefault();
    let hit: TreeNode | undefined;
    const walk = (n: TreeNode) => {
      if (hit || (filteredIds && !filteredIds.has(n.id))) return;
      if (n.selectable !== false && matchesQuery(n.search ?? n.label, query)) hit = n;
      else n.children?.forEach(walk);
    };
    nodes.forEach(walk);
    if (hit) toggleNode(hit);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-2">
        <SearchInput value={query} onChange={setQuery} onKeyDown={onSearchKey} placeholder={searchPlaceholder} />
        {single ? (
          groupIds.length > 0 && (
            <div data-testid="tree-picker-header" className="flex flex-nowrap items-center justify-end px-0.5 text-xs">
              <IconAction
                label={allExpanded ? "Collapse all" : "Expand all"}
                onClick={() => expandAll(!allExpanded)}
              >
                {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
              </IconAction>
            </div>
          )
        ) : (
        <div data-testid="tree-picker-header" className="flex flex-nowrap items-center gap-1 px-0.5 text-xs">
          <span className="mr-auto whitespace-nowrap text-muted-foreground tabular-nums">
            {selectedCount} selected
          </span>
          <IconAction
            label={allExpanded ? "Collapse all" : "Expand all"}
            onClick={() => expandAll(!allExpanded)}
          >
            {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
          </IconAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleAll}
            aria-label={allSelected ? "Deselect all" : "Select all"}
            className={cn(
              "ml-1 h-6 gap-1 whitespace-nowrap rounded-full px-2 text-[0.7rem] font-semibold",
              allSelected ? "text-[var(--sd-data-red)] hover:text-[var(--sd-data-red)]" : "text-primary",
            )}
          >
            {allSelected ? <CircleX className="h-3.5 w-3.5" /> : <CircleCheck className="h-3.5 w-3.5" />}
            {allSelected ? "Deselect all" : "Select all"}
          </Button>
        </div>
        )}
        <div className="-mx-1 max-h-72 overflow-auto px-1">{nodes.map((n) => renderNode(n, 0))}</div>
      </div>
    </TooltipProvider>
  );
}

export type TreePickerProps = TreePickerPanelProps & {
  /** pill text and (unless `ariaLabel`) accessible name, e.g. "Farms" */
  label: string;
  ariaLabel?: string;
  /** replaces "label count" on the pill with a value, e.g. the picked farm */
  valueText?: string;
  icon?: ReactNode;
  /** the figure on the pill; defaults to the number checked */
  count?: number;
  disabled?: boolean;
  className?: string;
  /** "field" is the boxed look of form pages */
  variant?: "pill" | "field";
  onOpenChange?: (open: boolean) => void;
};

const FIELD_TRIGGER =
  "h-9 w-full justify-between gap-2 rounded-md border-input bg-background px-3 text-sm font-normal shadow-sm hover:shadow-sm";

export function TreePicker({
  label, ariaLabel, valueText, icon, count, disabled, className, variant = "pill", onOpenChange, ...panel
}: TreePickerProps) {
  const [open, setOpen] = useState(false);
  const n = count ?? panel.checked.size;
  const change = (o: boolean) => {
    setOpen(o);
    onOpenChange?.(o);
  };
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          title={valueText}
          className={cn(variant === "field" ? FIELD_TRIGGER : HEADER_PILL, valueText !== undefined && "min-w-0 max-w-[16rem]", className)}
          disabled={disabled}
        >
          {icon}
          {valueText !== undefined ? (
            <span className="min-w-0 flex-1 truncate">{valueText}</span>
          ) : (
            <>
              {label}
              <span className="tabular-nums text-muted-foreground">{n || "—"}</span>
            </>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2">
        <TreePickerPanel {...panel} onPick={() => change(false)} />
      </PopoverContent>
    </Popover>
  );
}
