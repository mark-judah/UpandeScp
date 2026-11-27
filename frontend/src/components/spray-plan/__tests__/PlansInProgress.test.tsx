import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlansInProgress } from "@/components/spray-plan/PlansInProgress";

const summary = vi.fn();
vi.mock("@/lib/lifecycle-api", () => ({
  fetchLifecycleSummary: (a: unknown) => summary(a),
}));
vi.mock("@/lib/spray-ticket-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-ticket-api")>()),
  getSprayTicket: async (wo: string) => ({ work_order: wo, percent: wo.endsWith("17") ? 100 : 74, printable: false, stopped: false, missing: [], lines: [] }),
}));

const row = (name: string, state: string) => ({
  name, current_state: state, current_step: "approved", stopped: false, missed: false,
  greenhouse: "PH1-AV10B2 - MUT", spray_type: "Preventive", scheduled: "2026-11-27 09:00:00",
});

describe("PlansInProgress", () => {
  it("lists submitted plans with stage and ticket %, scoped to the crop, without drafts", async () => {
    summary.mockResolvedValue([row("MFG-WO-2026-00017", "Tank Mix Manufactured"), row("MFG-WO-2026-00016", "Approved")]);
    render(<PlansInProgress crop="Avocado" />);
    expect(await screen.findByText("Tank Mix Manufactured")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("100%")).toBeInTheDocument());
    expect(screen.getByText("74%")).toBeInTheDocument();
    expect(screen.getAllByText("PH1-AV10B2")).toHaveLength(2);
    const args = summary.mock.calls[0][0];
    expect(args.crop).toBe("Avocado");
    expect(args.states).not.toContain("Pending Submission");
    expect(args.states).toContain("Completed");
  });

  it("reloads when drafts are submitted", async () => {
    summary.mockReset();
    summary.mockResolvedValue([]);
    render(<PlansInProgress />);
    expect(await screen.findByText(/No plans sent for approval/)).toBeInTheDocument();
    summary.mockResolvedValue([row("MFG-WO-2026-00019", "Awaiting Approval")]);
    act(() => { window.dispatchEvent(new Event("spray-plan:submitted")); });
    expect(await screen.findByText("Awaiting Approval")).toBeInTheDocument();
  });
});
