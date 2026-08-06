import { recordCall } from "./perf";

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

export async function call<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const fetchStart = performance.now();
  const res = await fetch(`/api/method/${method}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Frappe-CSRF-Token": csrf(),
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(args),
  });

  let body: unknown = null;
  const text = await res.text();
  const fetchMs = performance.now() - fetchStart;

  const parseStart = performance.now();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const parseMs = performance.now() - parseStart;

  recordCall(method, res.url, text, fetchStart, fetchMs, parseMs);

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
    throw new FrappeError(msg, res.status, body);
  }

  if (body && typeof body === "object" && "message" in body) {
    return (body as { message: T }).message;
  }
  return body as T;
}
