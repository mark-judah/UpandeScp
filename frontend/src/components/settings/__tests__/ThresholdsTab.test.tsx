import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getThresholds = vi.fn();
const saveThresholds = vi.fn();
const listCrops = vi.fn();
vi.mock("@/lib/thresholds-api", () => ({
  getThresholds: (...a: unknown[]) => getThresholds(...a),
  saveThresholds: (...a: unknown[]) => saveThresholds(...a),
  listCrops: (...a: unknown[]) => listCrops(...a),
}));

import { ThresholdsTab } from "@/components/settings/ThresholdsTab";

beforeEach(() => {
  getThresholds.mockReset().mockImplementation(async (crop: string) => ({ crop, pests: [], diseases: [] }));
  saveThresholds.mockReset().mockResolvedValue({ ok: true });
  listCrops.mockReset().mockResolvedValue(["Avocado", "Coffee", "Rose"]);
});

describe("ThresholdsTab", () => {
  it("loads the route crop and has no crop picker", async () => {
    render(<ThresholdsTab crop="Avocado" />);
    await waitFor(() => expect(getThresholds).toHaveBeenCalledWith("Avocado"));
    expect(listCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });

  it("follows the prop when the route crop changes", async () => {
    const { rerender } = render(<ThresholdsTab crop="Avocado" />);
    await waitFor(() => expect(getThresholds).toHaveBeenCalledWith("Avocado"));
    rerender(<ThresholdsTab crop="Coffee" />);
    await waitFor(() => expect(getThresholds).toHaveBeenLastCalledWith("Coffee"));
  });

  it("saves under the route crop", async () => {
    render(<ThresholdsTab crop="Avocado" />);
    const save = await screen.findByRole("button", { name: /save/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);
    expect(saveThresholds).toHaveBeenCalledWith("Avocado", { crop: "Avocado", pests: [], diseases: [] });
  });
});
