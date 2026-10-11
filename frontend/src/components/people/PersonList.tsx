/**
 * The left column: everyone, searchable, the selected one marked by fill.
 * Ported in shape from Livestock's AnimalSearch. Rows may carry a leading rank
 * and a trailing figure (a score, weighted hours); groups are titled sections.
 */
import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { cn } from "@/lib/utils";

export interface PersonListItem {
  id: string;
  name: string;
  image?: string | null;
  /** second line: farm, team, role … */
  sub?: string;
  /** extra text the search also matches */
  keywords?: string;
  rank?: number;
  /** right-hand figure and its caption */
  figure?: string;
  figureHint?: string;
}

export interface PersonListGroup {
  title?: string;
  note?: string;
  items: PersonListItem[];
}

const CAP = "max-h-[min(62vh,600px)]";

export function PersonList({
  groups,
  selectedId,
  onSelect,
  placeholder = "Name, ID or farm…",
  label = "Find a person",
  noun = "people",
}: {
  groups: PersonListGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  placeholder?: string;
  label?: string;
  noun?: string;
}) {
  const [term, setTerm] = useState("");
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const shown = useMemo(() => {
    const q = term.trim().toLowerCase();
    if (!q) return groups;
    return groups.map((g) => ({
      ...g,
      items: g.items.filter((p) =>
        [p.id, p.name, p.sub || "", p.keywords || ""].some((f) => f.toLowerCase().includes(q)),
      ),
    }));
  }, [groups, term]);
  const matches = shown.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sd-quiet)]" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="h-11 rounded-[var(--sd-radius-pill)] border-[var(--sd-line)] bg-[var(--sd-bg-soft)] pl-9 pr-9 text-[13px]"
        />
        {term && (
          <button
            type="button"
            onClick={() => setTerm("")}
            aria-label="Clear the search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sd-quiet)] hover:text-[var(--sd-ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <p className="px-1 text-[11.5px] text-[var(--sd-quiet)]">
        {matches === total ? `${total} ${noun}` : `${matches} of ${total}`}
      </p>
      <div className={cn("flex min-h-0 flex-col gap-3 overflow-y-auto", CAP)}>
        {shown.map((g, gi) =>
          g.items.length ? (
            <section key={g.title || gi} className="flex flex-col gap-1">
              {g.title && (
                <div className="flex items-center gap-3 px-1 pb-1">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sd-quiet)]">
                    {g.title}
                  </h3>
                  <span className="h-px flex-1 bg-[var(--sd-line-soft)]" />
                  <span className="text-[11px] tabular-nums text-[var(--sd-quiet)]">{g.items.length}</span>
                </div>
              )}
              {g.note && <p className="px-1 pb-1 text-[11px] text-[var(--sd-quiet)]">{g.note}</p>}
              <ul className="flex flex-col gap-1">
                {g.items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(p.id)}
                      data-testid={`person-${p.id}`}
                      aria-current={p.id === selectedId ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-[var(--sd-radius-lg)] px-3 py-2.5 text-left transition-colors",
                        p.id === selectedId ? "bg-[var(--sd-bg-soft)]" : "hover:bg-[var(--sd-bg-soft)]",
                      )}
                    >
                      {p.rank != null && (
                        <span className="w-6 shrink-0 text-right text-[12px] font-semibold tabular-nums text-[var(--sd-quiet)]">
                          {p.rank}
                        </span>
                      )}
                      <PersonAvatar id={p.id} name={p.name} image={p.image} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13.5px] font-medium text-[var(--sd-ink)]">{p.name}</span>
                        {p.sub && <span className="truncate text-[11.5px] text-[var(--sd-muted)]">{p.sub}</span>}
                      </span>
                      {p.figure != null && (
                        <span className="flex shrink-0 flex-col items-end">
                          <span className="text-[13px] font-semibold tabular-nums text-[var(--sd-ink)]">{p.figure}</span>
                          {p.figureHint && (
                            <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--sd-quiet)]">
                              {p.figureHint}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null,
        )}
        {!matches && (
          <p className="rounded-[var(--sd-radius-lg)] bg-[var(--sd-bg-soft)] px-3 py-6 text-center text-[12.5px] text-[var(--sd-muted)]">
            {term ? `Nobody matches “${term}”.` : `No ${noun} in this range.`}
          </p>
        )}
      </div>
    </div>
  );
}
