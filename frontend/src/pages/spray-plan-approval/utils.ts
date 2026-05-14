export function todayISO(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function parseTargets(raw?: string | null): string[] {
  if (!raw) return []
  return raw
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function fmtQty(val: number | string | null | undefined): string {
  if (val === null || val === undefined) return "—"
  const n = typeof val === "number" ? val : parseFloat(val)
  if (Number.isNaN(n)) return String(val)
  if (n % 1 === 0) return String(n)
  return n.toFixed(3).replace(/\.?0+$/, "")
}

export function fmtScheduledDate(raw?: string | null): string {
  if (!raw) return "—"
  return raw.split(" ")[0]
}

export function fmtCreation(raw?: string | null): string {
  if (!raw) return "—"
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

export function escapeHtml(str: unknown): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
