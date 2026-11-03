/** "9:05:00" → "09:05:00". The server sends a Time as a timedelta, which
 *  serialises without the leading zero, so as text "9:xx" sorts after "10:xx". */
export function padTime(t?: string | null): string {
  if (!t) return "";
  return String(t).replace(/^(\d):/, "0$1:");
}

/** "<date> <HH:MM:SS>" for ordering entries by when they were captured. */
export function captureStamp(e: { date_of_capture?: string | null; time_of_capture?: string | null }): string {
  return `${e.date_of_capture || ""} ${padTime(e.time_of_capture)}`.trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2031-12-01 08:05:00" → "1 Dec 2031 · 08:05"; a bare date stays a date. */
export function formatCapture(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(stamp || "");
  if (!m) return stamp || "";
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  return m[4] ? `${day} · ${m[4]}:${m[5]}` : day;
}
