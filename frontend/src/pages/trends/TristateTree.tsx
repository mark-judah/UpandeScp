import { useMemo, useState } from "react";
import { ChevronDown, Check, Minus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CheckState, TreeNode } from "./trends-types";

export type TristateTreeProps = {
  nodes: TreeNode[];
  checked: Set<string>;
  onChange: (next: Set<string>) => void;
  emptyHint?: string;
  searchPlaceholder?: string;
};

function collectLeafIds(node: TreeNode): string[] {
  if (!node.children?.length) return [node.id];
  return node.children.flatMap(collectLeafIds);
}

function nodeState(node: TreeNode, checked: Set<string>): CheckState {
  if (checked.has(node.id)) return "checked";
  // Surface a hint when a parent isn't itself selected but some of its
  // descendants are — useful for spotting "Karen + Karen GH 01" style mixes.
  if (node.children?.length) {
    const someChild = node.children.some((c) => nodeState(c, checked) !== "unchecked");
    if (someChild) return "indeterminate";
  }
  return "unchecked";
}

export function TristateTree({
  nodes,
  checked,
  onChange,
  emptyHint = "No items in range.",
  searchPlaceholder = "Search…",
}: TristateTreeProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(nodes.map((n) => n.id)),
  );

  const filteredIds = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.trim().toLowerCase();
    const visible = new Set<string>();
    const walk = (n: TreeNode): boolean => {
      const self = n.label.toLowerCase().includes(q);
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

  const toggleNode = (n: TreeNode) => {
    // Non-cascading: clicking a parent toggles the parent's own ID only,
    // so a farm node represents an aggregate selection rather than every
    // greenhouse beneath it. Leaves still toggle individually.
    const next = new Set(checked);
    if (next.has(n.id)) next.delete(n.id);
    else next.add(n.id);
    onChange(next);
  };

  const allLeafIds = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TreeNode) => {
      if (!n.children?.length) out.push(n.id);
      else n.children.forEach(walk);
    };
    nodes.forEach(walk);
    return out;
  }, [nodes]);

  const selectAllGlobal = () => onChange(new Set(allLeafIds));

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
    if (!open) {
      setExpanded(new Set());
      return;
    }
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

  const renderNode = (n: TreeNode, depth: number): React.ReactNode => {
    if (filteredIds && !filteredIds.has(n.id)) return null;
    const state = nodeState(n, checked);
    const open = expanded.has(n.id);
    const hasChildren = !!n.children?.length;
    return (
      <div key={n.id} style={{ paddingLeft: depth * 14 }}>
        <div
          className={cn(
            "group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/60 cursor-pointer",
            state === "checked" && "bg-muted/40",
          )}
          onClick={() => toggleNode(n)}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(n.id)) next.delete(n.id);
                  else next.add(n.id);
                  return next;
                });
              }}
              className="h-4 w-4 flex items-center justify-center text-muted-foreground"
            >
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  !open && "-rotate-90",
                )}
              />
            </button>
          ) : (
            <span className="w-4" />
          )}
          <span
            className={cn(
              "h-4 w-4 shrink-0 rounded-sm border flex items-center justify-center",
              state === "checked" && "bg-primary text-primary-foreground border-primary",
              state === "indeterminate" && "bg-primary text-primary-foreground border-primary",
              state === "unchecked" && "bg-background",
            )}
          >
            {state === "checked" && <Check className="h-3 w-3" />}
            {state === "indeterminate" && <Minus className="h-3 w-3" />}
          </span>
          <span className="text-sm truncate flex-1">{n.label}</span>
          {typeof n.count === "number" && (
            <span className="text-[0.7rem] text-muted-foreground tabular-nums">
              {n.count}
            </span>
          )}
        </div>
        {hasChildren && open && (
          <>
            <div
              className="flex items-center gap-1 pl-7 py-0.5"
              style={{ paddingLeft: depth * 14 + 28 }}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  selectSubtree(n);
                }}
                className="text-[0.7rem] font-medium text-primary hover:underline"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  unselectSubtree(n);
                }}
                className="text-[0.7rem] font-medium text-[var(--sd-data-red)] hover:underline ml-2"
              >
                Unselect
              </button>
            </div>
            <div>{n.children!.map((c) => renderNode(c, depth + 1))}</div>
          </>
        )}
      </div>
    );
  };

  if (!nodes.length) {
    return <div className="text-xs text-muted-foreground p-3">{emptyHint}</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[0.7rem]">
        <button
          type="button"
          onClick={selectAllGlobal}
          className="text-[0.75rem] font-semibold text-primary hover:underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set())}
          className="text-[0.75rem] font-semibold text-[var(--sd-data-red)] hover:underline ml-1"
        >
          Unselect
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[0.7rem] ml-2"
          onClick={() => expandAll(true)}
        >
          Expand
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[0.7rem]"
          onClick={() => expandAll(false)}
        >
          Collapse
        </Button>
        <span className="ml-auto text-muted-foreground">
          {checked.size} selected
        </span>
      </div>
      <div className="max-h-72 overflow-auto -mx-1 px-1">
        {nodes.map((n) => renderNode(n, 0))}
      </div>
    </div>
  );
}
