import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

const call = vi.fn();
vi.mock("@/lib/frappe", async (orig) => ({
  ...(await orig<typeof import("@/lib/frappe")>()),
  call: (...a: unknown[]) => call(...a),
}));
const dl = vi.fn();
vi.mock("@/lib/labels-api", () => ({ downloadBase64Pdf: (...a: unknown[]) => dl(...a) }));

import { IssueListPdfButton, issueListParams } from "@/components/store/IssueListPdfButton";

afterEach(() => {
  cleanup();
  call.mockReset();
  dl.mockReset();
});

describe("issueListParams", () => {
  it("sends nothing for an empty selection and JSON for several", () => {
    expect(issueListParams("2026-11-11", { farms: [], greenhouses: [] })).toEqual({
      date: "2026-11-11", farms: undefined, greenhouses: undefined,
    });
    const p = issueListParams("2026-11-11", { farms: ["A", "B"], greenhouses: ["GH 1"] });
    expect(p.farms).toBe('["A","B"]');
    expect(p.greenhouses).toBe("GH 1");
  });
});

describe("IssueListPdfButton", () => {
  it("opens, downloads the PDF for the chosen day and reports counts", async () => {
    call.mockImplementation(async (m: string) =>
      m.endsWith("issue_list_places")
        ? { farms: ["Kap"], greenhouses_by_farm: { Kap: ["GH 1"] } }
        : { data: "JVBER", filename: "issue-list-all-2026-11-11.pdf", to_issue: 3, issued: 1 },
    );
    const u = userEvent.setup();
    render(<IssueListPdfButton />);
    await u.click(screen.getByRole("button", { name: "Issue list (PDF)" }));
    await u.click(await screen.findByRole("button", { name: /download pdf/i }));
    await waitFor(() => expect(dl).toHaveBeenCalledWith("JVBER", "issue-list-all-2026-11-11.pdf"));
    expect(await screen.findByText("3 to issue, 1 already issued.")).toBeTruthy();
    const dlCall = call.mock.calls.find((c) => String(c[0]).endsWith("download_issue_list_pdf"));
    expect(dlCall?.[1].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shows the error when the server refuses", async () => {
    call.mockImplementation(async (m: string) => {
      if (m.endsWith("issue_list_places")) return { farms: [], greenhouses_by_farm: {} };
      throw new Error("no role");
    });
    const u = userEvent.setup();
    render(<IssueListPdfButton />);
    await u.click(screen.getByRole("button", { name: "Issue list (PDF)" }));
    await u.click(await screen.findByRole("button", { name: /download pdf/i }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(dl).not.toHaveBeenCalled();
  });
});
