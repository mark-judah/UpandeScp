import { useEffect } from "react";

declare global {
  interface Window {
    frappe?: {
      realtime?: {
        on: (event: string, cb: (data: unknown) => void) => void;
        off?: (event: string, cb: (data: unknown) => void) => void;
      };
    };
  }
}

/**
 * Subscribe to a Frappe realtime event for the lifetime of the component.
 *
 * No-ops gracefully if Frappe's socket.io client isn't loaded — useful for
 * the standalone /scp_app shell which doesn't pull frappe-web.bundle.
 */
export function useRealtime<T = unknown>(
  event: string,
  handler: (data: T) => void,
) {
  useEffect(() => {
    const rt = window.frappe?.realtime;
    if (!rt) return;
    const wrapped = (data: unknown) => handler(data as T);
    rt.on(event, wrapped);
    return () => {
      rt.off?.(event, wrapped);
    };
  }, [event, handler]);
}
