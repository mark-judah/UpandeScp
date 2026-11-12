/**
 * IT monitor: the phone-fleet dashboard (spec 2026-11-12-scp-it-monitor.md).
 * Backend: upande_scp.serverscripts.it_monitor.dashboard (read-only, SCP IT /
 * System Manager / SCP General Manager). Every reader here is tolerant: a field
 * the server leaves out reads as null / 0 / [] rather than crashing the page.
 */
import { FrappeError } from "./frappe";
import { parseNames } from "./places";

const API = "upande_scp.serverscripts.it_monitor.dashboard";

/** The dashboard endpoints are GET-only (`methods=["GET"]`), which the shared POST `call` cannot reach. */
async function call<T = unknown>(path: string, args: Record<string, unknown> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = path.startsWith("/") ? path : `/api/method/${path}`;
  const res = await fetch(`${url}${qs.toString() ? (url.includes("?") ? "&" : "?") + qs : ""}`, {
    credentials: "include",
    headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new FrappeError(String(o.exception ?? o.message ?? res.statusText ?? "Request failed"), res.status, body);
  }
  return body && typeof body === "object" && "message" in body ? (body as { message: T }).message : (body as T);
}

/** The roles that see the IT monitor (the server admits the same). */
export const IT_ROLES = ["SCP IT", "System Manager", "SCP General Manager", "Administrator"];

export function canSeeItMonitor(roles: string[]): boolean {
  return IT_ROLES.some((r) => roles.includes(r));
}

export const LOW_BATTERY = 0.2;
export const LOW_STORAGE_BYTES = 1024 ** 3;
export const DORMANT_DAYS = 7;

export type DeviceStatus = "Current" | "Behind" | "Dormant" | "Unknown";
export const DEVICE_STATUSES: DeviceStatus[] = ["Current", "Behind", "Dormant", "Unknown"];

export interface QueueStat {
  pending: number;
  failed: number;
  held: number;
  refused: number;
  oldest_at: string | null;
  /** stuck as the server computed it (failed + held + refused + items pending too long) */
  stuck: number;
}

export interface ItDevice {
  install_id: string;
  user: string | null;
  user_full_name: string | null;
  employee: string | null;
  employee_name: string | null;
  farm: string | null;
  app_role: string | null;
  status: DeviceStatus;
  platform: string | null;
  device_brand: string | null;
  device_model: string | null;
  device_name: string | null;
  os_version: string | null;
  app_version: string | null;
  runtime_version: string | null;
  update_id: string | null;
  channel: string | null;
  build_type: string | null;
  previous_app_version: string | null;
  version_changed_at: string | null;
  first_seen: string | null;
  last_seen: string | null;
  last_login_at: string | null;
  launches: number;
  ip_address: string | null;
  battery_level: number | null;
  battery_state: string | null;
  low_power: boolean;
  storage_free_bytes: number | null;
  storage_total_bytes: number | null;
  memory_total_bytes: number | null;
  network_type: string | null;
  connectivity: string | null;
  clock_skew_seconds: number | null;
  last_sync_at: string | null;
  last_sync_ok_at: string | null;
  last_sync_error: string | null;
  pending_total: number;
  stuck_total: number;
  oldest_pending_at: string | null;
  queues: Record<string, QueueStat>;
  snapshot: Record<string, unknown> | null;
  it_notes: string | null;
}

export interface ItEvent {
  event_id: string;
  kind: string;
  level: string | null;
  ts: string | null;
  message: string | null;
  error_name: string | null;
  stack: string | null;
  fatal: boolean;
  count: number;
  screen: string | null;
  app_version: string | null;
  req_method: string | null;
  req_url: string | null;
  req_status: number | null;
  req_duration_ms: number | null;
  req_error: string | null;
  fingerprint: string | null;
}

export interface ItOverview {
  devices: {
    total: number;
    active_24h: number;
    behind: number;
    dormant: number;
    low_battery: number;
    low_storage: number;
    with_stuck: number;
  };
  versions: { app_version: string; runtime_version: string | null; devices: number }[];
  latest_app_version: string | null;
  errors: { events: number; issues: number; crashes: number };
  logins_today: number;
  stuck_by_queue: Record<string, number>;
}

export interface ItIssue {
  fingerprint: string;
  kind: string;
  title: string;
  events: number;
  users: number;
  devices: number;
  first_seen: string | null;
  last_seen: string | null;
  last_version: string | null;
}

export interface ItLogin {
  ts: string | null;
  user: string | null;
  full_name: string | null;
  operation: string; // Login / Logout
  status: string; // Success / Failed
  ip_address: string | null;
  install_id: string | null;
  app_version: string | null;
  device: string | null;
  farm: string | null;
  note: string | null;
}

/** one point of a per-day series: a date and named values */
export interface DayPoint {
  date: string;
  [series: string]: number | string;
}

export interface ItDataFlow {
  scouting: DayPoint[]; // per day, one column per scout
  scouts: string[];
  pest_photos: DayPoint[]; // {date, photos}
  csu_scans: DayPoint[]; // {date, scans}
  spray_sessions: DayPoint[]; // {date, Synced, Held, Partial, Refused}
  queues: { name: string; pending: number; stuck: number; devices: number }[];
}

/* ------------------------------ coercion ------------------------------ */

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A JSON column may arrive as an object or as its string. */
function jsonish(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

export function normaliseQueues(raw: unknown): Record<string, QueueStat> {
  const out: Record<string, QueueStat> = {};
  for (const [name, q] of Object.entries(jsonish(raw) ?? {})) {
    const o = rec(q);
    out[name] = {
      pending: num(o.pending),
      failed: num(o.failed),
      held: num(o.held),
      refused: num(o.refused),
      oldest_at: str(o.oldest_at),
      stuck: o.stuck === undefined ? num(o.failed) + num(o.held) + num(o.refused) : num(o.stuck),
    };
  }
  return out;
}

export function normaliseDevice(raw: unknown): ItDevice {
  const r = rec(raw);
  const status = DEVICE_STATUSES.includes(r.status as DeviceStatus) ? (r.status as DeviceStatus) : "Unknown";
  return {
    install_id: String(r.install_id ?? r.name ?? ""),
    user: str(r.user),
    user_full_name: str(r.user_full_name ?? r.full_name),
    employee: str(r.employee),
    employee_name: str(r.employee_name),
    farm: str(r.farm),
    app_role: str(r.app_role),
    status,
    platform: str(r.platform),
    device_brand: str(r.device_brand),
    device_model: str(r.device_model),
    device_name: str(r.device_name),
    os_version: str(r.os_version),
    app_version: str(r.app_version),
    runtime_version: str(r.runtime_version),
    update_id: str(r.update_id),
    channel: str(r.channel),
    build_type: str(r.build_type),
    previous_app_version: str(r.previous_app_version),
    version_changed_at: str(r.version_changed_at),
    first_seen: str(r.first_seen),
    last_seen: str(r.last_seen),
    last_login_at: str(r.last_login_at),
    launches: num(r.launches),
    ip_address: str(r.ip_address),
    battery_level: numOrNull(r.battery_level),
    battery_state: str(r.battery_state),
    low_power: !!num(r.low_power),
    storage_free_bytes: numOrNull(r.storage_free_bytes),
    storage_total_bytes: numOrNull(r.storage_total_bytes),
    memory_total_bytes: numOrNull(r.memory_total_bytes),
    network_type: str(r.network_type),
    connectivity: str(r.connectivity),
    clock_skew_seconds: numOrNull(r.clock_skew_seconds),
    last_sync_at: str(r.last_sync_at),
    last_sync_ok_at: str(r.last_sync_ok_at),
    last_sync_error: str(r.last_sync_error),
    pending_total: num(r.pending_total),
    stuck_total: num(r.stuck_total),
    oldest_pending_at: str(r.oldest_pending_at),
    queues: normaliseQueues(r.queues),
    snapshot: jsonish(r.device_snapshot ?? r.snapshot),
    it_notes: str(r.it_notes),
  };
}

export function normaliseEvent(raw: unknown): ItEvent {
  const r = rec(raw);
  return {
    event_id: String(r.event_id ?? r.name ?? ""),
    kind: String(r.kind ?? "error"),
    level: str(r.level),
    ts: str(r.ts),
    message: str(r.message),
    error_name: str(r.error_name),
    stack: str(r.stack),
    fatal: !!num(r.fatal),
    count: Math.max(1, num(r.count, 1)),
    screen: str(r.screen),
    app_version: str(r.app_version),
    req_method: str(r.req_method),
    req_url: str(r.req_url),
    req_status: numOrNull(r.req_status),
    req_duration_ms: numOrNull(r.req_duration_ms),
    req_error: str(r.req_error),
    fingerprint: str(r.fingerprint),
  };
}

export function normaliseOverview(raw: unknown): ItOverview {
  const r = rec(raw);
  const d = rec(r.devices);
  const e = rec(r.errors);
  const stuck: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec(r.stuck_by_queue))) stuck[k] = num(v);
  return {
    devices: {
      total: num(d.total),
      active_24h: num(d.active_24h),
      behind: num(d.behind),
      dormant: num(d.dormant),
      low_battery: num(d.low_battery),
      low_storage: num(d.low_storage),
      with_stuck: num(d.with_stuck),
    },
    versions: arr(r.versions).map((v) => {
      const o = rec(v);
      return { app_version: String(o.app_version ?? "unknown"), runtime_version: str(o.runtime_version), devices: num(o.devices) };
    }),
    latest_app_version: str(r.latest_app_version),
    errors: { events: num(e.events), issues: num(e.issues), crashes: num(e.crashes) },
    logins_today: num(r.logins_today),
    stuck_by_queue: stuck,
  };
}

export function normaliseIssue(raw: unknown): ItIssue {
  const r = rec(raw);
  return {
    fingerprint: String(r.fingerprint ?? ""),
    kind: String(r.kind ?? "error"),
    title: String(r.title ?? r.message ?? r.error_name ?? "(no message)"),
    events: num(r.events),
    users: num(r.users),
    devices: num(r.devices),
    first_seen: str(r.first_seen),
    last_seen: str(r.last_seen),
    last_version: str(r.last_version),
  };
}

export function normaliseLogin(raw: unknown): ItLogin {
  const r = rec(raw);
  return {
    ts: str(r.ts ?? r.creation ?? r.time),
    user: str(r.user),
    full_name: str(r.full_name ?? r.user_full_name),
    operation: String(r.operation ?? r.subject ?? "Login"),
    status: String(r.status ?? "Success"),
    ip_address: str(r.ip_address),
    install_id: str(r.install_id ?? r.device),
    app_version: str(r.app_version),
    device: str(r.device_model ?? r.device_name ?? r.device),
    farm: str(r.farm),
    note: str(r.subject ?? r.note ?? r.reason),
  };
}

/** Rows as `{date, series, count}` or already-wide `{date, a, b}` both become wide. */
export function toWide(rows: unknown, valueKey = "count"): DayPoint[] {
  const byDate = new Map<string, DayPoint>();
  for (const raw of arr(rows)) {
    const r = rec(raw);
    const date = str(r.date ?? r.day);
    if (!date) continue;
    const pt = byDate.get(date) ?? { date };
    const series = str(r.scout ?? r.status ?? r.series ?? r.user);
    if (series && (valueKey in r || "entries" in r || "value" in r)) {
      pt[series] = num(pt[series], 0) + num(r[valueKey] ?? r.entries ?? r.value);
    } else {
      for (const [k, v] of Object.entries(r)) {
        if (k === "date" || k === "day") continue;
        if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)))) {
          pt[k] = num(pt[k], 0) + num(v);
        }
      }
    }
    byDate.set(date, pt);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** the series (column) names across points, excluding date, by descending total */
export function seriesOf(points: DayPoint[]): string[] {
  const totals = new Map<string, number>();
  for (const p of points)
    for (const [k, v] of Object.entries(p)) if (k !== "date") totals.set(k, (totals.get(k) ?? 0) + num(v));
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** Keep the `max` busiest series and fold the rest into "Others". */
export function topSeries(points: DayPoint[], max = 8): { points: DayPoint[]; series: string[] } {
  const all = seriesOf(points);
  if (all.length <= max) return { points, series: all };
  const keep = all.slice(0, max);
  const rest = all.slice(max);
  const folded = points.map((p) => {
    const out: DayPoint = { date: p.date };
    for (const k of keep) out[k] = num(p[k]);
    out.Others = rest.reduce((s, k) => s + num(p[k]), 0);
    return out;
  });
  return { points: folded, series: [...keep, "Others"] };
}

export function normaliseDataFlow(raw: unknown): ItDataFlow {
  const r = rec(raw);
  const daily = arr(r.daily).map(rec);
  const pick = (map: Record<string, string>): DayPoint[] =>
    daily.map((d) => {
      const pt: DayPoint = { date: String(d.date ?? "") };
      for (const [out, from] of Object.entries(map)) pt[out] = num(d[from]);
      return pt;
    });
  // one row per (day, scout); the scout's name when the server knows it
  const scouting = toWide(
    arr(r.scouting_by_scout).map((x) => {
      const o = rec(x);
      return { date: o.date, scout: o.scout_name ?? o.scout, count: o.entries };
    }),
  );
  const queuesRaw = r.device_queues ?? r.queues;
  const queues: ItDataFlow["queues"] = Array.isArray(queuesRaw)
    ? queuesRaw.map((q) => {
        const o = rec(q);
        return { name: String(o.name ?? ""), pending: num(o.pending), stuck: num(o.stuck), devices: num(o.devices) };
      })
    : Object.entries(rec(queuesRaw)).map(([name, q]) => {
        const o = rec(q);
        return { name, pending: num(o.pending), stuck: num(o.stuck), devices: num(o.devices) };
      });
  const hasAny = (pts: DayPoint[]) => pts.some((p) => Object.entries(p).some(([k, v]) => k !== "date" && num(v) > 0));
  const keepIf = (pts: DayPoint[]) => (hasAny(pts) ? pts : []);
  return {
    scouting: keepIf(scouting),
    scouts: seriesOf(scouting),
    pest_photos: keepIf(pick({ Photos: "pest_photos" })),
    csu_scans: keepIf(pick({ Scans: "csu_scans" })),
    spray_sessions: keepIf(pick({ Synced: "spray_synced", Partial: "spray_partial", Held: "spray_held", Refused: "spray_refused", Pending: "spray_pending" })),
    queues: queues.filter((q) => q.name),
  };
}

/* ------------------------------ endpoints ------------------------------ */

const clean = (a: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== ""));

export async function fetchOverview(days = 7, farm?: string): Promise<ItOverview> {
  return normaliseOverview(await call(`${API}.overview`, clean({ days, farm })));
}

export interface DeviceFilters {
  farm?: string;
  status?: string;
  search?: string;
  stuck_only?: boolean;
}

export async function fetchDevices(f: DeviceFilters = {}): Promise<ItDevice[]> {
  const r = await call<unknown>(
    `${API}.devices`,
    clean({ farm: f.farm, status: f.status, search: f.search, stuck_only: f.stuck_only ? 1 : 0, limit: 500 }),
  );
  return arr(Array.isArray(r) ? r : rec(r).devices ?? rec(r).rows).map(normaliseDevice);
}

export async function fetchDevice(install_id: string): Promise<{ device: ItDevice; events: ItEvent[] }> {
  const r = rec(await call(`${API}.device`, { install_id }));
  const base = rec(r.device ?? r);
  return {
    device: normaliseDevice({ ...base, queues: r.queues ?? base.queues, device_snapshot: r.snapshot ?? base.device_snapshot }),
    events: arr(r.events).map(normaliseEvent),
  };
}

export async function fetchIssues(days = 7, kind?: string): Promise<ItIssue[]> {
  const r = await call<unknown>(`${API}.issues`, clean({ days, kind }));
  return arr(Array.isArray(r) ? r : rec(r).issues).map(normaliseIssue);
}

/** Events of one fingerprint, read from Frappe's list API (SCP IT has read on SCP Mobile Event). */
export async function fetchIssueEvents(fingerprint: string, days = 7): Promise<ItEvent[]> {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const r = await call<unknown>("/api/resource/SCP Mobile Event", {
    fields: JSON.stringify([
      "name", "event_id", "kind", "level", "ts", "message", "error_name", "stack", "fatal", "count", "screen",
      "app_version", "req_method", "req_url", "req_status", "req_duration_ms", "req_error", "fingerprint",
    ]),
    filters: JSON.stringify([["fingerprint", "=", fingerprint], ["ts", ">=", since]]),
    order_by: "ts desc",
    limit_page_length: 50,
  });
  return arr(Array.isArray(r) ? r : rec(r).data).map(normaliseEvent);
}

export async function fetchLogins(days = 7, farm?: string): Promise<ItLogin[]> {
  const r = await call<unknown>(`${API}.logins`, clean({ days, farm }));
  return arr(Array.isArray(r) ? r : rec(r).rows ?? rec(r).logins).map(normaliseLogin);
}

export async function fetchDataFlow(days = 7, farm?: string): Promise<ItDataFlow> {
  return normaliseDataFlow(await call(`${API}.data_flow`, clean({ days, farm })));
}

/* ------------------------------ formatting ------------------------------ */

/** Frappe datetimes are "YYYY-MM-DD HH:mm:ss" (site time); ISO also accepted. */
export function parseTs(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}

export function relativeTime(ts: string | null | undefined, now: Date = new Date()): string {
  const d = parseTs(ts);
  if (!d) return "never";
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} d ago`;
  return `${Math.floor(days / 30)} mo ago`;
}

export function formatBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, b);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function batteryPct(level: number | null | undefined): number | null {
  if (level === null || level === undefined || level < 0) return null;
  return Math.round(Math.min(1, level) * 100);
}

export function isLowBattery(d: Pick<ItDevice, "battery_level">): boolean {
  return d.battery_level !== null && d.battery_level >= 0 && d.battery_level < LOW_BATTERY;
}
export function isLowStorage(d: Pick<ItDevice, "storage_free_bytes">): boolean {
  return d.storage_free_bytes !== null && d.storage_free_bytes < LOW_STORAGE_BYTES;
}

export function deviceLabel(d: ItDevice): string {
  return d.user_full_name || d.employee_name || d.user || d.install_id;
}

export function deviceModel(d: ItDevice): string {
  return [d.device_brand, d.device_model].filter(Boolean).join(" ") || d.device_name || "Unknown device";
}

/** Dotted version compare: "1.0.12" > "1.0.9". Non-numeric parts compare as 0. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = (a ?? "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = (b ?? "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Queue rows worth showing: those with anything pending or stuck. */
export function queueRows(q: Record<string, QueueStat>) {
  return Object.entries(q).map(([name, s]) => ({ name, ...s }));
}

/** Client-side narrowing, so the table reacts to typing without a round trip. */
export function filterDevices(rows: ItDevice[], f: DeviceFilters): ItDevice[] {
  const q = (f.search ?? "").trim().toLowerCase();
  return rows.filter((d) => {
    const farms = parseNames(f.farm);
    if (farms.length && !farms.includes(d.farm ?? "")) return false;
    if (f.status && d.status !== f.status) return false;
    if (f.stuck_only && d.stuck_total <= 0) return false;
    if (q) {
      const hay = [d.user, d.user_full_name, d.employee_name, d.install_id, d.device_model, d.device_brand, d.app_version]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Overview tiles, in display order. `tone` marks the ones that want attention when > 0. */
export function overviewTiles(o: ItOverview): { key: string; label: string; value: number; warn: boolean; stuck?: boolean }[] {
  const d = o.devices;
  return [
    { key: "total", label: "Devices", value: d.total, warn: false },
    { key: "active_24h", label: "Active in 24 h", value: d.active_24h, warn: false },
    { key: "behind", label: "Behind on version", value: d.behind, warn: d.behind > 0 },
    { key: "dormant", label: "Dormant (7 d+)", value: d.dormant, warn: d.dormant > 0 },
    { key: "low_battery", label: "Low battery (<20%)", value: d.low_battery, warn: d.low_battery > 0 },
    { key: "low_storage", label: "Low storage (<1 GB)", value: d.low_storage, warn: d.low_storage > 0 },
    { key: "with_stuck", label: "With stuck data", value: d.with_stuck, warn: d.with_stuck > 0, stuck: true },
  ];
}

export const QUEUE_LABELS: Record<string, string> = {
  scouting: "Scouting entries",
  pest_images: "Pest photos",
  spray_sessions: "Spray sessions",
  sprayer_gps: "Sprayer GPS",
  traps: "Traps",
  team_journal: "Team journal",
  other: "Other",
};
export const queueLabel = (n: string) => QUEUE_LABELS[n] ?? n.replace(/_/g, " ");

/** Short URL path for an API event: no host, no query string. */
export function shortPath(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url, "http://x").pathname;
  } catch {
    return url.split("?")[0];
  }
}
