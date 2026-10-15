import { useEffect, useRef } from "react";
import {
  POLL_MS,
  SPRAY_PLAN_EVENT,
  eventMatches,
  type LiveScope,
  type SprayPlanEvent,
} from "@/lib/approval-live";

type Socket = {
  connected?: boolean;
  /** frappe.realtime wraps the raw socket.io client here */
  socket?: { connected?: boolean };
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  off?: (ev: string, cb: (...args: unknown[]) => void) => void;
};

/** Frappe's socket.io client, where the host page loaded it (desk). The
 *  standalone shell may not have it, in which case polling carries the page. */
function socket(): Socket | null {
  const w = window as unknown as { frappe?: { realtime?: Socket; socketio?: { socket?: Socket } } };
  return w.frappe?.realtime ?? w.frappe?.socketio?.socket ?? null;
}

/**
 * Keep the approvals list live. Calls `refresh` when:
 *  - a `scp:spray_plan` event matches the page's date range and place (debounced);
 *  - every POLL_MS, but only while the socket is not connected (a connected
 *    socket is trusted; a dead one is exactly when polling is needed);
 *  - the window regains focus or the tab becomes visible.
 * Realtime is an optimisation: `refresh` re-reads the list, so none of these can
 * leave the page wrong, only late.
 */
export function useLiveApprovals(scope: LiveScope, refresh: () => void, pollMs = POLL_MS) {
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let timer: number | undefined;
    const soon = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => refreshRef.current(), 400);
    };
    const onEvent = (data: unknown) => {
      if (eventMatches(data as SprayPlanEvent, scopeRef.current)) soon();
    };
    const s = socket();
    s?.on(SPRAY_PLAN_EVENT, onEvent);

    const poll = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const c = socket();
      if (c && (c.connected ?? c.socket?.connected)) return;
      refreshRef.current();
    }, pollMs);
    const onFocus = () => {
      if (document.visibilityState !== "hidden") refreshRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);

    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      s?.off?.(SPRAY_PLAN_EVENT, onEvent);
    };
  }, [pollMs]);
}
