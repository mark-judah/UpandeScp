import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listOpenAlerts = vi.fn();
const acknowledgeAlert = vi.fn();
vi.mock("@/lib/scouting-alerts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scouting-alerts-api")>()),
  listOpenAlerts: (...a: unknown[]) => listOpenAlerts(...a),
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));
vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#000", disease: () => "#000" }),
}));
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: () => ({ data: null, loading: false, error: null, progress: null, reload: vi.fn() }),
}));

import { OverviewTab } from "../OverviewTab";

const thrips = {
  name: "SA-2031-W20-abc", crop: "Rose", farm: "Chepsito", warehouse: "Chepsito GH 01 - KR",
  kind: "Pest", observation: "Thrips", stage: "", iso_week: "2031-W20", measure: "Percentage",
  unit: "%", value: 33.3, margin: 18, reliability: "Fair", sections_scouted: 9, sections_total: 9,
  band: "High", action: "Spray advised", status: "Open",
};
const aphids = {
  ...thrips, name: "SA-2031-W20-def", observation: "Aphids", measure: "Count", unit: "per zone",
  value: 1.2, margin: null, sections_scouted: 1, reliability: "Low", band: "Moderate", action: "Alarming",
};

beforeEach(() => {
  listOpenAlerts.mockReset().mockResolvedValue([thrips, aphids]);
  acknowledgeAlert.mockReset().mockResolvedValue({ name: thrips.name, status: "Acknowledged" });
});

const renderTab = (extra = {}) =>
  render(<OverviewTab data={null} scoutLookup={{}} fromDate="2031-05-12" toDate="2031-05-18" crop="Rose" {...extra} />);

describe("Overview active alerts", () => {
  it("lists the stored alerts of the crop, farm and greenhouse in scope", async () => {
    renderTab({ farm: "Chepsito", greenhouse: "" });
    const rows = await screen.findAllByTestId("active-alert");
    expect(listOpenAlerts).toHaveBeenCalledWith({ crop: "Rose", farm: "Chepsito", greenhouse: "" });
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("33.3% · ±18 · 9/9")).toBeInTheDocument();
    expect(within(rows[0]).getByTestId("alert-action")).toHaveTextContent("Spray advised");
    expect(within(rows[1]).getByText("1.2 per zone · too clustered to judge · 1/9")).toBeInTheDocument();
    expect(within(rows[1]).getByTestId("reliability-pill")).toHaveTextContent("Low");
  });

  it("acknowledges in place", async () => {
    renderTab();
    const [first] = await screen.findAllByTestId("active-alert");
    await userEvent.click(within(first).getByRole("button", { name: "Acknowledge" }));
    expect(acknowledgeAlert).toHaveBeenCalledWith(thrips.name);
    await waitFor(() => expect(within(first).getByText("Acknowledged")).toBeInTheDocument());
    expect(within(first).queryByRole("button", { name: "Acknowledge" })).toBeNull();
  });

  it("says so quietly when acknowledging is denied, and keeps the row open", async () => {
    acknowledgeAlert.mockRejectedValue(Object.assign(new Error("frappe.exceptions.PermissionError"), { status: 403 }));
    renderTab();
    const [first] = await screen.findAllByTestId("active-alert");
    await userEvent.click(within(first).getByRole("button", { name: "Acknowledge" }));
    expect(await within(first).findByText("You don't have permission to acknowledge this alert")).toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "Acknowledge" })).toBeEnabled();
  });

  it("offers a retry message on any other failure", async () => {
    acknowledgeAlert.mockRejectedValue(new Error("boom"));
    renderTab();
    const [first] = await screen.findAllByTestId("active-alert");
    await userEvent.click(within(first).getByRole("button", { name: "Acknowledge" }));
    expect(await within(first).findByText("Couldn't acknowledge — try again")).toBeInTheDocument();
    expect(within(first).getByRole("button", { name: "Acknowledge" })).toBeInTheDocument();
  });

  it("asks for nothing without a crop", () => {
    render(<OverviewTab data={null} scoutLookup={{}} fromDate="" toDate="" />);
    expect(listOpenAlerts).not.toHaveBeenCalled();
    expect(screen.getByText("No active alerts")).toBeInTheDocument();
  });
});
