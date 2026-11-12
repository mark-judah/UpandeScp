import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
  if (method.endsWith(".availability")) {
    return { crop: "Avocado", ready: [{ farm: "Lokitela", blocks: 4 }, { farm: "Mutara", blocks: 3 }], blocked: [] };
  }
  if (method.endsWith(".report_weeks")) return [{ year: 2026, week: 45, entries: 9, label: "W45" }];
  void args;
  return null;
});
vi.mock("@/lib/frappe", async (orig) => ({ ...(await orig<typeof import("@/lib/frappe")>()), call: (m: string, a?: Record<string, unknown>) => call(m, a) }));

const { BlockWeeklyReport } = await import("@/pages/BlockWeeklyReport");

describe("BlockWeeklyReport - several farms", () => {
  it("opens on the first farm, then asks for the weeks of every farm picked", async () => {
    const user = userEvent.setup();
    render(<BlockWeeklyReport crop="Avocado" />);
    await waitFor(() => expect(call).toHaveBeenCalledWith(expect.stringMatching(/report_weeks$/), { crop: "Avocado", farm: "Lokitela" }));
    await user.click(await screen.findByRole("button", { name: "Block report farm" }));
    await user.click(await screen.findByText("Mutara"));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(expect.stringMatching(/report_weeks$/), {
        crop: "Avocado",
        farm: JSON.stringify(["Lokitela", "Mutara"]),
      }),
    );
  });
});
