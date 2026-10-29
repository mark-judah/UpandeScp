/**
 * Inline multi-user chip picker for the Spray Plan Access admin page.
 *
 * Props:
 *  - value: the currently assigned creator users (display + remove)
 *  - onChange: parent-supplied callback; emits the *full* next list
 *  - disabled: locks the picker (e.g. while saving)
 *
 * The Add input opens a server-side typeahead that filters Frappe Users
 * by name/email AND restricts to users who hold the "SCP Spray Plan Creator"
 * role (the backend SQL is in admin.list_spray_plan_creator_candidates).
 */

import { SearchInput } from "@/components/SearchInput";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plus, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  listApproverCandidates,
  listCreatorCandidates,
  listProductionSupervisorCandidates,
  listStoreKeeperCandidates,
  type CreatorCandidate,
  type FarmCreatorRow,
} from "@/lib/spray-plan-admin-api";

interface Props {
  value: FarmCreatorRow[];
  onChange: (next: FarmCreatorRow[]) => void;
  disabled?: boolean;
  /** Which role's candidate list to search. Defaults to "creator" so the
   *  existing AccessTab callsites keep working unchanged. */
  kind?: "creator" | "approver" | "storekeeper" | "production";
}

export function CreatorChipPicker({
  value,
  onChange,
  disabled,
  kind = "creator",
}: Props) {
  const fetchCandidates =
    kind === "approver"
      ? listApproverCandidates
      : kind === "storekeeper"
        ? listStoreKeeperCandidates
        : kind === "production"
          ? listProductionSupervisorCandidates
          : listCreatorCandidates;
  const roleLabel =
    kind === "approver"
      ? "SCP Spray Plan Approver"
      : kind === "storekeeper"
        ? "SCP Chemical Store Keeper"
        : kind === "production"
          ? "SCP Production Supervisor"
          : "SCP Spray Plan Creator";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CreatorCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The picker sits inside a scrolling table, which clips anything positioned
  // inside it. The menu is portalled to <body> and placed under the input.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const floating = (children: ReactNode, className: string, onMouseDown?: (e: React.MouseEvent) => void) =>
    pos
      ? createPortal(
          <div
            className={`fixed z-[1000] min-w-56 rounded-md border bg-popover shadow-md ${className}`}
            style={{ top: pos.top, left: pos.left }}
            onMouseDown={onMouseDown}
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      fetchCandidates(query)
        .then((rows) => {
          setResults(
            rows.filter((r) => !value.find((v) => v.user === r.user)),
          );
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, value]);

  const add = (c: CreatorCandidate) => {
    onChange([
      ...value,
      { user: c.user, full_name: c.full_name || c.user },
    ]);
    setQuery("");
    setOpen(false);
  };

  const remove = (user: string) => {
    onChange(value.filter((v) => v.user !== user));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((v) => (
        <span
          key={v.user}
          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.7rem] font-medium"
        >
          {v.full_name || v.user}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(v.user)}
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Remove ${v.full_name || v.user}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <div className="relative" ref={anchorRef}>
          {open ? (
            <div className="flex items-center gap-1">
              <SearchInput className="w-44" value={query} onChange={setQuery}
                placeholder="search users…"
                autoFocus
                onBlur={() => {
                  setTimeout(() => setOpen(false), 150);
                }}
                />
              {searching && <Loader2 className="h-3 w-3 animate-spin" />}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[0.7rem] text-muted-foreground hover:bg-muted/50"
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          )}
          {open && results.length > 0 &&
            floating(
              results.map((r) => (
                <button
                  type="button"
                  key={r.user}
                  onClick={() => add(r)}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-muted"
                >
                  <div className="font-medium">{r.full_name || r.user}</div>
                  <div className="text-[0.65rem] text-muted-foreground">
                    {r.email || r.user}
                  </div>
                </button>
              )),
              "max-h-60 overflow-auto",
              (e) => e.preventDefault(),
            )}
          {open && !searching && results.length === 0 && query &&
            floating(
              <>
                No users found. Only enabled accounts with the
                {" "}&quot;{roleLabel}&quot;{" "}role appear here. Grant the
                role in Frappe Desk first if you need to give a user access.
              </>,
              "px-3 py-2 text-xs text-muted-foreground",
            )}
        </div>
      )}
    </div>
  );
}
