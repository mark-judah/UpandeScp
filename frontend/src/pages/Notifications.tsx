/**
 * Notifications page.
 *
 * Not crop-scoped — unlike every other page here — so it is reached from the
 * header bell rather than a crop sidebar, where it would appear once per crop and
 * imply the notifications were crop-specific.
 */

import { errorText } from "@/lib/errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Check, CheckCheck } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { TextSkeleton } from "@/components/Loading";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  busiestCategory,
  capCount,
  fetchCategoryCounts,
  fetchNotifications,
  type CategoryCounts,
  markRead,
  relativeTime,
  routeForNotification,
  type ScpCategory,
  type ScpNotification,
} from "@/lib/notifications-api";

const CATEGORIES: Array<ScpCategory | ""> = [
  "",
  "loan",
  "transfer",
  "procurement",
  "stock",
  "scouting",
  "plan",
  "reentry",
];

/** Unread count on a tab: muted pill, filled accent on the busiest tab. */
export function CountBubble({
  loading, value, emphasised, active,
}: { loading: boolean; value: number | undefined; emphasised?: boolean; active?: boolean }) {
  if (loading) {
    return (
      <span
        data-testid="count-skeleton"
        aria-hidden
        className="inline-block h-4 min-w-[1.25rem] animate-pulse rounded-full bg-[var(--sd-bg-soft)]"
      />
    );
  }
  if (value === undefined) return null;
  return (
    <span
      data-testid="count-bubble"
      data-emphasised={emphasised || undefined}
      title={`${value} unread`}
      className={cn(
        "inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full px-1 text-[0.65rem] font-medium tabular-nums",
        emphasised
          ? "bg-primary text-primary-foreground"
          : active
            ? "bg-background/20 text-background"
            : "bg-muted text-muted-foreground",
      )}
    >
      {capCount(value)}
    </span>
  );
}

export function Notifications() {
  const [category, setCategory] = useState<ScpCategory | "">("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [rows, setRows] = useState<ScpNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [tabCounts, setTabCounts] = useState<CategoryCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchNotifications({ category, unreadOnly, limit: 100 });
      setRows(r.notifications);
      setUnread(r.unread);
      setLoadError(null);
    } catch (e) {
      // Ends the skeleton: an empty list under the error, not rows pulsing on.
      setLoadError(errorText(e, "Could not load notifications."));
      setRows((prev) => prev ?? []);
    }
  }, [category, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  // Bubbles come from one grouped count, so every tab shows on first paint
  // even though the list below loads one category at a time.
  const loadCounts = useCallback(async () => {
    setTabCounts(await fetchCategoryCounts());
    setCountsLoading(false);
  }, []);
  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);
  const busiest = busiestCategory(tabCounts);

  const onOpen = async (n: ScpNotification) => {
    if (!n.read) {
      await markRead({ names: [n.name] });
      setRows((prev) =>
        (prev ?? []).map((r) => (r.name === n.name ? { ...r, read: 1 } : r)),
      );
      setUnread((u) => Math.max(0, u - 1));
      void loadCounts();
    }
    const route = routeForNotification(n);
    if (route) window.location.hash = route.replace(/^#/, "");
  };

  const onMarkAll = async () => {
    setUnread(await markRead({ all: true }));
    setRows((prev) => (prev ?? []).map((r) => ({ ...r, read: 1 })));
    void loadCounts();
  };

  const grouped = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Notifications"
        eyebrow={
          unread
            ? `${unread} unread`
            : rows === null
            ? <TextSkeleton width="9ch" />
            : "Nothing unread"
        }
      />

      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 pb-3">
        {CATEGORIES.map((c) => (
          <button
            key={c || "all"}
            type="button"
            onClick={() => setCategory(c)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
              category === c
                ? "border-foreground bg-foreground text-background"
                : "hover:bg-muted",
            )}
          >
            {c ? CATEGORY_LABEL[c] : "All"}
            <CountBubble
              loading={countsLoading}
              value={c ? tabCounts?.counts[c]?.unread : tabCounts?.unread}
              emphasised={!!c && c === busiest}
              active={category === c}
            />
          </button>
        ))}
        <button
          type="button"
          onClick={() => setUnreadOnly((v) => !v)}
          className={cn(
            "h-7 rounded-full border px-2.5 text-xs transition-colors",
            unreadOnly
              ? "border-foreground bg-foreground text-background"
              : "hover:bg-muted",
          )}
        >
          Unread only
        </button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-7 gap-1 text-xs"
          disabled={!unread}
          onClick={onMarkAll}
        >
          <CheckCheck className="h-3.5 w-3.5" />
          Mark all read
        </Button>
      </div>

      <div className="px-4 md:px-6 pb-6" aria-busy={rows === null || undefined}>
        {loadError && (
          <p role="alert" className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {loadError}
          </p>
        )}
        {rows === null ? (
          // Rows at the real row's size: the unread dot, subject and preview
          // lines, the category pill and the time.
          <div className="flex flex-col gap-1.5" aria-hidden>
            {["62%", "48%", "70%", "54%", "66%"].map((w, i) => (
              <div
                key={i}
                data-skeleton="row"
                className="flex items-start gap-3 rounded-md border border-[var(--sd-line-soft)] bg-card px-3 py-2.5"
              >
                <span className="mt-1 h-2 w-2 shrink-0" />
                <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
                  <TextSkeleton width={w} />
                  <span className="block h-[10px] w-[40%] animate-pulse rounded bg-[var(--sd-bg-soft)]" />
                </span>
                <TextSkeleton width="7ch" />
              </div>
            ))}
          </div>
        ) : !grouped.length ? (
          <Card className="flex flex-col items-center gap-2 p-12 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--sd-pistachio)]">
              <Bell className="h-5 w-5 text-muted-foreground" />
            </div>
            <CardTitle className="text-base">You're all caught up</CardTitle>
            <CardDescription>
              {category || unreadOnly
                ? "Nothing here with these filters."
                : "Loan requests, transfers, procurement reviews and scouting alerts will show up here."}
            </CardDescription>
          </Card>
        ) : (
          <div className="flex flex-col gap-1.5">
            {grouped.map((n) => {
              const linked = !!routeForNotification(n);
              return (
                <button
                  key={n.name}
                  type="button"
                  onClick={() => onOpen(n)}
                  className={cn(
                    "flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    n.read
                      ? "border-[var(--sd-line-soft)] bg-card"
                      : "border-[var(--sd-line)] bg-[var(--sd-bg-soft)]",
                    linked && "hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "mt-1 h-2 w-2 shrink-0 rounded-full",
                      n.read ? "bg-transparent" : "bg-[var(--sd-data-cyan)]",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm",
                        n.read ? "text-muted-foreground" : "font-medium",
                      )}
                      // Subjects are app-authored, never user HTML.
                      dangerouslySetInnerHTML={{ __html: n.subject }}
                    />
                    {n.email_content && n.email_content !== n.subject ? (
                      <span
                        className="mt-0.5 block truncate text-xs text-muted-foreground"
                        dangerouslySetInnerHTML={{ __html: n.email_content }}
                      />
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {n.scp_category ? (
                      <span className="rounded-full px-1.5 py-px text-[0.6rem] text-muted-foreground ring-1 ring-[var(--sd-line)]">
                        {CATEGORY_LABEL[n.scp_category]}
                      </span>
                    ) : null}
                    <span className="text-[0.65rem] tabular-nums text-muted-foreground">
                      {relativeTime(n.creation)}
                    </span>
                    {n.read ? (
                      <Check className="h-3 w-3 text-muted-foreground" />
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
