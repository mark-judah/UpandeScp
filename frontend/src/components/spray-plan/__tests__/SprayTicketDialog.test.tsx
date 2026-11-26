import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SprayTicketDialog } from "@/components/spray-plan/SprayTicketDialog";
import type { SprayTicket } from "@/lib/spray-ticket-api";

// A plain function, not vi.fn: vitest's spy tracks a rejected result on a promise
// nobody handles, which fails the run for the error test.
let impl: () => Promise<SprayTicket> = async () => {
  throw new Error("unset");
};
const getSprayTicket = {
  mockResolvedValue(t: SprayTicket) {
    impl = async () => t;
  },
  mockRejected(m: string) {
    impl = async () => {
      throw new Error(m);
    };
  },
};
vi.mock("@/lib/spray-ticket-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-ticket-api")>()),
  getSprayTicket: () => impl(),
}));

const ticket = (over: Partial<SprayTicket> = {}): SprayTicket => ({
  work_order: "MFG-WO-2026-00003",
  percent: 94,
  printable: false,
  stopped: false,
  missing: ["Crop stage"],
  lines: [
    { key: "block", label: "Block", group: "details", value: "P1-B1", filled: true, hint: null },
    {
      key: "crop_stage",
      label: "Crop stage",
      group: "details",
      value: null,
      filled: false,
      hint: "Set the crop stage on the crop cycle in Production",
    },
    { key: "authorized", label: "Technical authorization", group: "signoff", value: "Ann · 2026-11-02 08:00", filled: true, hint: null },
    { key: "phi", label: "Pre-harvest interval", group: "spray", value: "7 days", filled: true, hint: null },
  ],
  ...over,
});


describe("SprayTicketDialog", () => {
  it("shows the ring, the missing list and the grouped lines", async () => {
    getSprayTicket.mockResolvedValue(ticket());
    render(<SprayTicketDialog workOrder="MFG-WO-2026-00003" onClose={() => {}} />);
    expect(screen.getByTestId("ticket-skeleton")).toBeInTheDocument();
    expect(await screen.findByText("94%")).toBeInTheDocument();
    expect(screen.getByTestId("missing-list")).toHaveTextContent("Crop stage");
    for (const h of ["Details", "Sign-offs", "Spray"]) {
      expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
    }
    expect(screen.getByText("P1-B1")).toBeInTheDocument();
    expect(screen.getByText("Ann · 2026-11-02 08:00")).toBeInTheDocument();
    expect(
      screen.getByText("Set the crop stage on the crop cycle in Production"),
    ).toBeInTheDocument();
  });

  it("disables Print below 100% and says what is missing", async () => {
    getSprayTicket.mockResolvedValue(ticket());
    render(<SprayTicketDialog workOrder="MFG-WO-2026-00003" onClose={() => {}} />);
    const btn = await screen.findByRole("button", { name: /print/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", expect.stringContaining("Crop stage"));
  });

  it("links Print to the print view at 100%", async () => {
    getSprayTicket.mockResolvedValue(ticket({ percent: 100, printable: true, missing: [] }));
    render(<SprayTicketDialog workOrder="MFG-WO-2026-00003" onClose={() => {}} />);
    const link = await screen.findByRole("link", { name: /print/i });
    expect(link).toHaveAttribute(
      "href",
      "/printview?doctype=Work%20Order&name=MFG-WO-2026-00003&format=SCP%20Spray%20Ticket&no_letterhead=1",
    );
  });

  it("shows an inline error when the load fails", async () => {
    getSprayTicket.mockRejected("nope");
    render(<SprayTicketDialog workOrder="MFG-WO-2026-00003" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});
