// Thin Frappe API client for SCP.
//
// In production (served by Frappe), the page bridges session info via
// window.__SCP__. In Vite dev mode (`npm run dev`), the same API is reached
// through the proxy in vite.config.ts; CSRF is fetched from the proxied site.

export interface ScpBootstrap {
  greenhouses: { name: string; custom_farm?: string | null }[]
  sprayEquipment: { kit: string; warehouse?: string | null }[]
}

declare global {
  interface Window {
    __SCP__?: {
      csrf_token?: string
      user?: string
      bootstrap?: ScpBootstrap
    }
    csrf_token?: string
  }
}

export const bootstrap = (): ScpBootstrap =>
  window.__SCP__?.bootstrap ?? { greenhouses: [], sprayEquipment: [] }

const getCsrfToken = (): string | undefined =>
  window.__SCP__?.csrf_token || window.csrf_token

export class FrappeError extends Error {
  status: number
  data: unknown
  constructor(message: string, status: number, data: unknown) {
    super(message)
    this.name = "FrappeError"
    this.status = status
    this.data = data
  }
}

type CallArgs = Record<string, unknown>

/**
 * Call a Frappe @whitelist'd Python method.
 * Matches Frappe's convention: returns the payload under `message`.
 */
export async function call<T = unknown>(method: string, args: CallArgs = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Frappe-CSRF-Token": getCsrfToken() ?? "",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json",
  }

  const res = await fetch(`/api/method/${method}`, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(args),
  })

  let body: unknown = null
  const text = await res.text()
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      // non-JSON response (HTML error page) — keep as text
      body = text
    }
  }

  if (!res.ok) {
    const exc =
      body && typeof body === "object" && "exception" in body
        ? String((body as { exception: unknown }).exception)
        : ""
    throw new FrappeError(exc || `Frappe call failed: ${method}`, res.status, body)
  }

  // Frappe whitelisted methods can either `return value` (→ { message: value })
  // or write to `frappe.response["data"] = value` (→ { data: value }). Handle both.
  if (body && typeof body === "object") {
    if ("message" in body) return (body as { message: T }).message
    if ("data" in body) return (body as { data: T }).data
  }
  return body as T
}

export const currentUser = (): string => window.__SCP__?.user ?? "Guest"
