declare global {
  interface Window {
    SCP?: {
      csrf_token?: string;
      bootstrap?: Record<string, unknown>;
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

export function bootstrap<T = Record<string, unknown>>(): T {
  return (window.SCP?.bootstrap || {}) as T;
}

export async function call<T = unknown>(
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
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
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

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
