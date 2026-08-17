/**
 * Unread count + live updates for the notification bell.
 *
 * The count is read from the server on mount and after any change. Realtime is
 * treated as an OPTIMISATION, never the source of truth: if the socketio process
 * is down the badge must still be right on a page load, so a realtime event only
 * triggers a re-read rather than incrementing a local counter that could drift.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchUnreadCount } from "@/lib/notifications-api";

const EVENT = "scp:notification";

type Socket = {
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  off?: (ev: string, cb: (...args: unknown[]) => void) => void;
};

function socket(): Socket | null {
  const w = window as unknown as { frappe?: { socketio?: { socket?: Socket }; realtime?: Socket } };
  return w.frappe?.realtime ?? w.frappe?.socketio?.socket ?? null;
}

export function useUnreadNotifications(): {
  unread: number;
  refresh: () => Promise<void>;
  setUnread: (n: number) => void;
} {
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    setUnread(await fetchUnreadCount());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchUnreadCount().then((n) => {
      if (!cancelled) setUnread(n);
    });

    const s = socket();
    const onEvent = () => {
      fetchUnreadCount().then((n) => {
        if (!cancelled) setUnread(n);
      });
    };
    s?.on(EVENT, onEvent);

    return () => {
      cancelled = true;
      s?.off?.(EVENT, onEvent);
    };
  }, []);

  return { unread, refresh, setUnread };
}
