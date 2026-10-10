import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveSprayPlanSettings = vi.fn();
vi.mock("@/lib/settings-api", () => ({
  saveSprayPlanSettings: (...a: unknown[]) => saveSprayPlanSettings(...a),
}));
vi.mock("@/components/settings/TimezoneCard", () => ({ TimezoneCard: () => null }));

import { SprayPlanTab } from "@/components/settings/SprayPlanTab";
import { ScoutCaptureCard, maxCountError } from "@/components/settings/ScoutCaptureCard";
import type { SprayPlanSettings } from "@/lib/settings-api";

const initial: SprayPlanSettings = {
  intro_note: "",
  irac_rotation_window_days: 14,
  frac_rotation_window_days: 14,
  weather_wind_green_max_kmh: 0,
  weather_wind_red_min_kmh: 0,
  weather_rain_green_max_pct: 0,
  weather_rain_red_min_pct: 0,
  weather_temp_green_min_c: 0,
  weather_temp_green_max_c: 0,
  weather_temp_red_max_c: 0,
  weather_temp_red_min_c: 0,
  default_chemical_expense_account: "",
  default_chemical_difference_account: "",
  spray_raw_chemical_account: "",
  spray_tank_mix_account: "",
  spray_expense_account: "",
  stamp_transfer_cost_center: 0,
  bypass_owner_check: 0,
  allow_submit_without_biometric: 0,
  auto_cancel_enabled: 0,
  auto_cancel_apply_to_backlog: 0,
  auto_cancel_dormant_days: 3,
  auto_cancel_activated_on: "",
  spray_cutoff_time: "10:00:00",
  postponement_max_days: 7,
  postponement_grace_minutes: 0,
  loaning_enabled: 0,
  allocation_balancing_enabled: 0,
  loaning_depletion_pct: 15,
  loaning_timeout_hours: 72,
  progress_email_enabled: 0,
  progress_email_hour: 18,
  allow_scout_photos: 1,
  allow_scout_comments: 1,
  max_count_per_observation: 15,
  csu_scan_verification: "labels",
  allowed_farms: [],
  exclude_keywords: [],
};

beforeEach(() => {
  saveSprayPlanSettings.mockReset().mockResolvedValue({ ok: true });
});

describe("maxCountError", () => {
  it("takes whole numbers from 1 to 10000 only", () => {
    expect([1, 15, 10000].map(maxCountError)).toEqual([null, null, null]);
    for (const bad of [0, 10001, -1, 2.5, Number.NaN]) {
      // The server's spec string, word for word.
      expect(maxCountError(bad)).toBe("Max count per observation must be a whole number from 1 to 10000.");
    }
  });
});

describe("ScoutCaptureCard", () => {
  it("shows each switch and the cap as the server sent them, with no side strip", () => {
    const { container } = render(
      <ScoutCaptureCard
        value={{ allow_scout_photos: 0, allow_scout_comments: 1, max_count_per_observation: 40 }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /scouts can attach photos/i })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /scouts can write comments/i })).toBeChecked();
    expect(screen.getByLabelText(/max count per observation/i)).toHaveValue(40);
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});

describe("SprayPlanTab scouting capture", () => {
  it("saves the three values through the spray plan save", async () => {
    render(<SprayPlanTab initial={initial} farms={[]} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /scouts can attach photos/i }));
    const max = screen.getByLabelText(/max count per observation/i);
    await userEvent.clear(max);
    await userEvent.type(max, "40");
    await userEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(saveSprayPlanSettings).toHaveBeenCalledWith(
      expect.objectContaining({ allow_scout_photos: 0, allow_scout_comments: 1, max_count_per_observation: 40 }),
    );
  });

  it("refuses a max count outside 1 to 10000 before it reaches the server", async () => {
    render(<SprayPlanTab initial={initial} farms={[]} />);
    const max = screen.getByLabelText(/max count per observation/i);
    await userEvent.clear(max);
    await userEvent.type(max, "0");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Max count per observation must be a whole number from 1 to 10000.",
    );
    expect(max).toHaveAccessibleDescription(/whole number from 1 to 10000/);
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
    await userEvent.clear(max);
    await userEvent.type(max, "10001");
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
    expect(saveSprayPlanSettings).not.toHaveBeenCalled();
  });
});
