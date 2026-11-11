/**
 * Spray plans cannot be scheduled in the past - no grace. The server refuses it too
 * (`spray_plan_creator/lateness.assert_not_in_past`); this keeps the pickers from
 * offering it in the first place.
 */
import { mergeDateTime, splitDateTime, ymd } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");

/** The next 5-minute slot at or after `now` as "HH:mm" (the time picker steps by 5). */
export function nextSlot(now: Date): string {
  const total = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() > 0 ? 1 : 0);
  const rounded = Math.ceil(total / 5) * 5;
  const capped = Math.min(rounded, 23 * 60 + 55);
  return `${pad(Math.floor(capped / 60))}:${pad(capped % 60)}`;
}

/**
 * Pull a "YYYY-MM-DD HH:mm:00" value up to now if it is earlier. A past day becomes
 * today; today with an earlier time becomes the next slot. Later values are untouched.
 */
export function clampNotPast(value: string, now: Date = new Date()): string {
  if (!value) return value;
  const today = ymd(now);
  const { date, time } = splitDateTime(value);
  if (date < today) return mergeDateTime(today, nextSlot(now));
  if (date === today && time < nextSlot(now).slice(0, 5)) {
    // Compare against the real minute, not the rounded slot, so picking "now" works.
    const nowHm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (time < nowHm) return mergeDateTime(today, nextSlot(now));
  }
  return value;
}

export function isPast(value: string, now: Date = new Date()): boolean {
  return !!value && clampNotPast(value, now) !== value;
}
