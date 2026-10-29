import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreatorChipPicker } from "../CreatorChipPicker";

vi.mock("@/lib/spray-plan-admin-api", () => {
  const rows = async () => [{ user: "jane@x.com", full_name: "Jane Creator", email: "jane@x.com" }];
  return { listCreatorCandidates: rows, listApproverCandidates: rows, listStoreKeeperCandidates: rows, listProductionSupervisorCandidates: rows };
});

describe("CreatorChipPicker", () => {
  it("renders the suggestions outside the clipping table, on top of the page", async () => {
    const { container } = render(
      <div style={{ overflow: "hidden" }} data-testid="clip">
        <CreatorChipPicker value={[]} onChange={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    const item = await waitFor(() => screen.getByText("Jane Creator"));
    expect(container.contains(item)).toBe(false);
    const menu = item.closest("div.fixed") as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.className).toContain("z-[1000]");
    expect(menu.parentElement).toBe(document.body);
  });
});
