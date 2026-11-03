import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ReportSenderCard, accountLabel } from "@/components/settings/ReportSenderCard";
import type { ReportEmailAccounts, ReportSenderRow } from "@/lib/settings-api";

const fetchReportEmailAccounts = vi.fn();
vi.mock("@/lib/settings-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/settings-api")>()),
  fetchReportEmailAccounts: () => fetchReportEmailAccounts(),
}));

const DATA: ReportEmailAccounts = {
  chosen: null,
  chosen_valid: true,
  default: "Main",
  suggested: "Spare",
  as_of: "now",
  companies: ["Roses Co", "Avocado Co"],
  accounts: [
    { name: "Main", email_id: "main@x.test", is_default: 1, server: "", last_hour: 40, queued: 2, failed: 0 },
    { name: "Spare", email_id: "spare@x.test", is_default: 0, server: "", last_hour: 1, queued: 0, failed: 3 },
  ],
};

function Host({ rows: initial, def = "", spy }: { rows: ReportSenderRow[]; def?: string; spy: (r: ReportSenderRow[]) => void }) {
  const [rows, setRows] = useState(initial);
  const [value, setValue] = useState(def);
  return (
    <ReportSenderCard
      value={value}
      onChange={setValue}
      rows={rows}
      onRowsChange={(r) => {
        setRows(r);
        spy(r);
      }}
    />
  );
}

beforeAll(() => {
  // Radix Select under jsdom.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  fetchReportEmailAccounts.mockReset().mockResolvedValue(DATA);
});

describe("ReportSenderCard", () => {
  it("shows the Default row first, then one row per company, with the chosen account's numbers", async () => {
    render(<Host rows={[{ company: "Roses Co", email_account: "Main" }]} def="Main" spy={vi.fn()} />);
    const rows = await screen.findAllByTestId("sender-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Default")).toBeTruthy();
    expect(within(rows[1]).getByText("Roses Co")).toBeTruthy();
    expect(within(rows[1]).getByText("40")).toBeTruthy();
    expect(within(rows[1]).getByText("sent last hour")).toBeTruthy();
  });

  it("flags a failing account and a suggested one", async () => {
    render(<Host rows={[{ company: "Roses Co", email_account: "Spare" }]} spy={vi.fn()} />);
    expect(await screen.findByText(/3 failed in the last 24 hours/)).toBeTruthy();
    expect(accountLabel(DATA.accounts[1], true)).toContain("Suggested");
    expect(accountLabel(DATA.accounts[0], false)).not.toContain("Suggested");
  });

  it("warns when a company's account no longer sends", async () => {
    render(<Host rows={[{ company: "Roses Co", email_account: "Gone" }]} spy={vi.fn()} />);
    expect(await screen.findByText(/no longer exists or has outgoing email turned off/)).toBeTruthy();
  });

  it("adds only companies without a row, and removes a row", async () => {
    const spy = vi.fn();
    render(<Host rows={[{ company: "Roses Co", email_account: "Main" }]} spy={spy} />);
    await screen.findAllByTestId("sender-row");
    await userEvent.click(screen.getByRole("combobox", { name: "Add company" }));
    expect(screen.queryByRole("option", { name: "Roses Co" })).toBeNull();
    await userEvent.click(await screen.findByRole("option", { name: "Avocado Co" }));
    expect(spy).toHaveBeenLastCalledWith([
      { company: "Roses Co", email_account: "Main" },
      { company: "Avocado Co", email_account: "" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Remove Roses Co" }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith([{ company: "Avocado Co", email_account: "" }]));
  });
});
