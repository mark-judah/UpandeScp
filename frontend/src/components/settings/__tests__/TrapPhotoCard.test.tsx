import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrapPhotoCard, trapPestRows, withRule } from "@/components/settings/TrapPhotoCard";

describe("TrapPhotoCard", () => {
  it("lists trap pests and any ruled pest, sorted, with the switch state", () => {
    expect(trapPestRows(["FCM", "Thrips"], [{ pest: "Mealybugs", photo_required: 1 }])).toEqual([
      { pest: "FCM", photo_required: 0 },
      { pest: "Mealybugs", photo_required: 1 },
      { pest: "Thrips", photo_required: 0 },
    ]);
  });

  it("does not store an off switch that was never on", () => {
    expect(withRule([], "FCM", false)).toEqual([]);
    expect(withRule([], "FCM", true)).toEqual([{ pest: "FCM", photo_required: 1 }]);
    expect(withRule([{ pest: "FCM", photo_required: 1 }], "FCM", false)).toEqual([{ pest: "FCM", photo_required: 0 }]);
  });

  it("toggles a pest through the switch", () => {
    const onChange = vi.fn();
    render(<TrapPhotoCard pests={["FCM"]} rules={[]} onChange={onChange} />);
    expect(screen.getByText("Traps")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /FCM/ }));
    expect(onChange).toHaveBeenCalledWith([{ pest: "FCM", photo_required: 1 }]);
  });
});
