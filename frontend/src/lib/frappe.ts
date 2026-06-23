export interface ScpBootstrap {
  user: string;
  full_name: string;
  user_image: string;
  site_name: string;
  roles: string[];
}

declare global {
  interface Window {
    SCP?: {
      csrf_token?: string;
      bootstrap?: Partial<ScpBootstrap> & Record<string, unknown>;
    };
    csrf_token?: string;
  }
}

export class FrappeError extends Error {
  status: number;
  payload: unknown;
  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function csrf(): string {
  return (
    window.SCP?.csrf_token ||
    window.csrf_token ||
    ""
  );
}

export function bootstrap(): ScpBootstrap {
  const raw = window.SCP?.bootstrap || {};
  return {
    user: typeof raw.user === "string" ? raw.user : "",
    full_name: typeof raw.full_name === "string" ? raw.full_name : "",
    user_image: typeof raw.user_image === "string" ? raw.user_image : "",
    site_name: typeof raw.site_name === "string" ? raw.site_name : "",
    roles: Array.isArray(raw.roles) ? (raw.roles as string[]) : [],
  };
}

/**
 * Verbose API tracing. Toggle at runtime from the browser console:
 *   localStorage.scp_debug = "1"   // enable
 *   delete localStorage.scp_debug  // disable
 * (or set window.SCP_DEBUG = true). Errors are ALWAYS logged regardless,
 * so failures the caller swallows (e.g. `catch { return [] }`) still surface.
 */
export function scpDebug(): boolean {
  try {
    return (
      localStorage.getItem("scp_debug") === "1" ||
      (window as unknown as { SCP_DEBUG?: boolean }).SCP_DEBUG === true
    );
  } catch {
    return false;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export async function call<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const dbg = scpDebug();
  const t0 = now();
  const short = method.split(".").pop() || method;
  if (dbg) console.debug(`%c[SCP] → fetching ${short}`, "color:#3b82f6", { method, args });

  let res: Response;
  try {
    res = await fetch(`/api/method/${method}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrf(),
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    // Network/transport failure — always surface it.
    console.error(`[SCP] ✗ ${short} — network error after ${Math.round(now() - t0)}ms`, { method, error: e });
    throw e;
  }

  let body: unknown = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const ms = Math.round(now() - t0);

  if (!res.ok) {
    const msg =
      (body && typeof body === "object" && "exception" in body
        ? String((body as Record<string, unknown>).exception)
        : null) ||
      (body && typeof body === "object" && "message" in body
        ? String((body as Record<string, unknown>).message)
        : null) ||
      res.statusText ||
      "Request failed";
    // Always log server errors — callers often swallow the throw.
    console.error(`[SCP] ✗ ${short} — HTTP ${res.status} (${ms}ms): ${msg}`, { method, body });
    throw new FrappeError(msg, res.status, body);
  }

  const out =
    body && typeof body === "object" && "message" in body
      ? (body as { message: T }).message
      : (body as T);
  if (dbg) {
    let size: number | string = "?";
    try {
      size = JSON.stringify(out)?.length ?? 0;
    } catch {
      /* unserialisable — ignore */
    }
    console.debug(
      `%c[SCP] ✓ fetched ${short} (${ms}ms, ${size} bytes)`,
      "color:#10b981",
    );
  }
  return out;
}
