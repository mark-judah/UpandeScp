import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapFloatingCard } from "../MapFloatingCard";

describe("MapFloatingCard", () => {
  it("sits bottom-right with the shared card look and shows eyebrow, title and children", () => {
    render(
      <MapFloatingCard eyebrow="Zone" title="GH 1 Z2" onClose={() => {}} className="extra">
        <p>body</p>
      </MapFloatingCard>,
    );
    const card = screen.getByRole("dialog", { name: "GH 1 Z2" });
    for (const c of ["absolute", "bottom-4", "right-4", "z-[1000]", "rounded-2xl", "scp-card-in", "extra"]) {
      expect(card.className).toContain(c);
    }
    expect(card.className).not.toContain("left-4");
    expect(screen.getByText("Zone")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("closes from the X button", () => {
    const onClose = vi.fn();
    render(<MapFloatingCard title="T" onClose={onClose} closeLabel="Close it" />);
    fireEvent.click(screen.getByLabelText("Close it"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape, and stops listening once unmounted", () => {
    const onClose = vi.fn();
    const { unmount } = render(<MapFloatingCard title="T" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
