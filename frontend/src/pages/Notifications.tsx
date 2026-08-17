/**
 * Notifications page.
 *
 * Not crop-scoped — unlike every other page here — so it is reached from the
 * header bell rather than a crop sidebar, where it would appear once per crop and
 * imply the notifications were crop-specific.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Check, CheckCheck } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  fetchNotifications,
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
];

export function Notifications() {
  const [category, setCategory] = useState<ScpCategory | "">("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [rows, setRows] = useState<ScpNotification[] | null>(null);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    const r = await fetchNotifications({ category, unreadOnly, limit: 100 });
    setRows(r.notifications);
    setUnread(r.unread);
  }, [category, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const onOpen = async (n: ScpNotification) => {
    if (!n.read) {
      await markRead({ names: [n.name] });
      setRows((prev) =>
        (prev ?? []).map((r) => (r.name === n.name ? { ...r, read: 1 } : r)),
      );
      setUnread((u) => Math.max(0, u - 1));
    }
    const route = routeForNotification(n);
    if (route) window.location.hash = route.replace(/^#/, "");
  };

  const onMarkAll = async () => {
    setUnread(await markRead({ all: true }));
    setRows((prev) => (prev ?? []).map((r) => ({ ...r, read: 1 })));
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
            ? "Loading…"
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
              "h-7 rounded-full border px-2.5 text-xs transition-colors",
              category === c
                ? "border-foreground bg-foreground text-background"
                : "hover:bg-muted",
            )}
          >
            {c ? CATEGORY_LABEL[c] : "All"}
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

      <div className="px-4 md:px-6 pb-6">
        {rows === null ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-muted/40" />
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
                : "Loan requests, transfers and procurement reviews will show up here."}
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
