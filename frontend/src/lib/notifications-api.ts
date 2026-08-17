/**
 * In-app notifications.
 *
 * Backed by Frappe's Notification Log, with our own `scp_category` taxonomy.
 * Every endpoint resolves the user server-side from the session — there is no
 * `for_user` parameter to pass, deliberately, so one user cannot read another's.
 */

import { call } from "./frappe";

export type ScpCategory = "loan" | "transfer" | "procurement" | "stock";

export interface ScpNotification {
  name: string;
  subject: string;
  email_content?: string;
  read: 0 | 1;
  creation: string;
  document_type?: string | null;
  document_name?: string | null;
  scp_category?: ScpCategory | null;
}

const BASE = "upande_scp.serverscripts.common.notifications";

export async function fetchNotifications(opts: {
  category?: ScpCategory | "";
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<{ notifications: ScpNotification[]; unread: number }> {
  try {
    const r = await call<{ notifications: ScpNotification[]; unread: number }>(
      `${BASE}.list_notifications`,
      {
        category: opts.category || undefined,
        unread_only: opts.unreadOnly ? 1 : 0,
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
      },
    );
    return { notifications: r?.notifications ?? [], unread: r?.unread ?? 0 };
  } catch {
    return { notifications: [], unread: 0 };
  }
}

export async function fetchUnreadCount(): Promise<number> {
  try {
    return Number(await call<number>(`${BASE}.unread_count`, {})) || 0;
  } catch {
    return 0;
  }
}

export async function markRead(
  arg: { names?: string[]; all?: boolean } = {},
): Promise<number> {
  try {
    const r = await call<{ unread: number }>(`${BASE}.mark_read`, {
      names: arg.names ? JSON.stringify(arg.names) : undefined,
      all: arg.all ? 1 : 0,
    });
    return r?.unread ?? 0;
  } catch {
    return await fetchUnreadCount();
  }
}

export const CATEGORY_LABEL: Record<ScpCategory, string> = {
  loan: "Loans",
  transfer: "Transfers",
  procurement: "Procurement",
  stock: "Stock",
};

/** Where a notification's reference should take the reader. Returns a route
 *  hash, or null when the referenced doctype has no page in this app — better a
 *  non-link than one that dead-ends. */
export function routeForNotification(n: ScpNotification): string | null {
  switch (n.document_type) {
    case "Chemical Transfer Request":
      return "#/rose/chemical-loaning";
    case "Work Order":
      return "#/rose/approvals";
    case "Material Request":
      return "#/rose/chemical-dashboard";
    default:
      return null;
  }
}

/** "3m ago" / "2h ago" / "5 Aug" — compact enough for a list row. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = new Date((iso || "").replace(" ", "T"));
  if (Number.isNaN(t.getTime())) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
