const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2031-12-01 08:05:00" → "1 Dec 2031 · 08:05"; a bare date stays a date. */
export function formatCapture(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(stamp || "");
  if (!m) return stamp || "";
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return m[4] ? `${day} · ${m[4]}:${m[5]}` : day;
}
