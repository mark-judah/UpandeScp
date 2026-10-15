import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/PestHeatmapModal", () => ({
  PestHeatmapModal: ({ observation }: { observation: string | null }) =>
    observation ? <div data-testid="modal-open">{observation}</div> : null,
}));
vi.mock("@/components/spray-plan/LifecycleTimeline", () => ({
  LifecycleTimelineFor: () => <div />,
}));

const { ApprovalActionBar, actionCaptions } = await import("@/components/spray-plan/ApprovalActionBar");
const { ApprovedList, progressPct, stepIndex } = await import("@/components/spray-plan/ApprovedList");
const { TargetPills } = await import("@/components/spray-plan/TargetPills");
const { replanHref } = await import("@/components/spray-plan/StalePlansTab");

const noop = () => {};
const bar = (count: number) => (
  <ApprovalActionBar count={count} busy={false} bulkBusy={false} stopConfirm={false}
    onApprove={noop} onQuick={noop} onStop={noop} onConfirmStop={noop} onCancelStop={noop} />
);

describe("ApprovalActionBar", () => {
  it("floats only while something is selected, with captions that carry the count", async () => {
    const { rerender } = render(bar(0));
    expect(screen.queryByTestId("approval-action-bar")).toBeNull();
    rerender(bar(3));
    expect(await screen.findByText("Send 3 plans to the store")).toBeInTheDocument();
    expect(screen.getByText("Cancel these 3 plans")).toBeInTheDocument();
    expect(screen.getByText("Skip the review")).toBeInTheDocument();
    const el = screen.getByTestId("approval-action-bar");
    expect(el.className).toMatch(/rounded-full/);
    expect(el.parentElement!.className).toMatch(/fixed/);
    rerender(bar(1));
    expect(await screen.findByText("Send 1 plan to the store")).toBeInTheDocument();
    rerender(bar(0));
    await waitFor(() => expect(screen.queryByTestId("approval-action-bar")).toBeNull());
  });

  it("words the captions", () => {
    expect(actionCaptions(1).stop).toBe("Cancel this plan");
  });
});

describe("Approved progress line", () => {
  it("maps step index to percent", () => {
    expect(stepIndex("Approved")).toBe(0);
    expect(stepIndex("Completed")).toBe(4);
    expect(stepIndex("Awaiting Approval")).toBe(-1);
    expect([0, 1, 2, 3, 4].map(progressPct)).toEqual([20, 40, 60, 80, 100]);
    expect(progressPct(-1)).toBe(0);
  });

  it("draws one line per approved plan, current node emphasised, no bar", () => {
    const rows = [
      { name: "WO-1", current_state: "Tank Mix Manufactured", current_step: "labels_scanned", stopped: false, missed: false, greenhouse: "GH 1", spray_type: null, scheduled: null, last_step_at: "2026-10-15 09:30:00" },
      { name: "WO-2", current_state: "Awaiting Approval", current_step: "created", stopped: false, missed: false, greenhouse: "GH 2", spray_type: null, scheduled: null },
    ] as any;
    render(<ApprovedList rows={rows} loading={false} />);
    const items = screen.getAllByTestId("approved-row");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("GH 1");
    expect(screen.getByTestId("progress-pct")).toHaveTextContent("60%");
    const nodes = screen.getAllByTestId("step-node");
    expect(nodes).toHaveLength(5);
    expect(nodes[2]).toHaveAttribute("data-current", "true");
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe("TargetPills", () => {
  it("shows an Open heatmap button on each pest that opens the modal", async () => {
    render(<TargetPills targets={["Spider Mites", "Botrytis"]} greenhouse="GH 1" crop="Rose" />);
    const buttons = screen.getAllByRole("button", { name: /Open heatmap/ });
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByText("Open heatmap")).toHaveLength(2);
    await userEvent.click(buttons[1]);
    expect(screen.getByTestId("modal-open")).toHaveTextContent("Botrytis");
  });
});

describe("replanHref", () => {
  it("carries house, targets, chemicals and tomorrow's date to the floor plan", () => {
    const href = replanHref(
      { name: "WO-9", custom_greenhouse: "GH 1", custom_targets: "Mites\nBotrytis", items: ["CHEM-1", "CHEM-2"] } as any,
      "Rose",
      new Date(2026, 9, 15),
    );
    expect(href.startsWith("#/rose/application-plan?")).toBe(true);
    const q = new URLSearchParams(href.split("?")[1]);
    expect(q.get("greenhouse")).toBe("GH 1");
    expect(q.get("date")).toBe("2026-10-16");
    expect(q.getAll("target")).toEqual(["Mites", "Botrytis"]);
    expect(q.getAll("item")).toEqual(["CHEM-1", "CHEM-2"]);
    expect(q.get("replan")).toBe("WO-9");
  });
});
