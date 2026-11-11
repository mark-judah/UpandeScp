/** Preview and test-send for the weekly spray records and avocado scout emails. */
import { call } from "./frappe";

export type WeeklyEmailKey = "spray_records" | "avocado_scout";

const NS = "upande_scp.serverscripts.reports";

const METHODS: Record<WeeklyEmailKey, { preview: string; test: string }> = {
  spray_records: {
    preview: `${NS}.spray_records_email.preview_spray_records_email`,
    test: `${NS}.spray_records_email.send_test_spray_records_email`,
  },
  avocado_scout: {
    preview: `${NS}.avocado_scout_email.preview_avocado_scout_email`,
    test: `${NS}.avocado_scout_email.send_test_avocado_scout_email`,
  },
};

export function previewWeeklyEmail(key: WeeklyEmailKey): Promise<string> {
  return call<string>(METHODS[key].preview, {});
}

export function sendTestWeeklyEmail(
  key: WeeklyEmailKey,
): Promise<{ sent: boolean; to?: string; reason?: string; farm?: string }> {
  return call(METHODS[key].test, {});
}
