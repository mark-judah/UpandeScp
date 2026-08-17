import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BomPicker, MAX_RENDERED_BOMS, type BomOption } from "@/components/BomPicker";

const boms: BomOption[] = [
  { name: "BOM-Th/fcm-561", item_name: "Botrytis Mix", custom_farm: "Kaptumbo" },
  { name: "BOM-Th/fcm-902", item_name: "Botrytis Heavy", custom_farm: "Torongo" },
  { name: "BOM-Th/xyz-004", item_name: "Downy Mildew Mix", custom_farm: "Kaptumbo" },
];

function open(props: Partial<React.ComponentProps<typeof BomPicker>> = {}) {
  const onValueChange = vi.fn();
  render(
    <BomPicker boms={boms} value="" onValueChange={onValueChange} {...props} />,
  );
  return { onValueChange, user: userEvent.setup() };
}

describe("BomPicker", () => {
  it("shows the placeholder until a tank mix is selected, then its label", () => {
    const { unmount } = render(
      <BomPicker boms={boms} value="" onValueChange={() => {}} />,
    );
    expect(screen.getByText("Select tank mix")).toBeInTheDocument();
    unmount();

    render(
      <BomPicker boms={boms} value="BOM-Th/fcm-902" onValueChange={() => {}} />,
    );
    expect(screen.getByText("Botrytis Heavy · Torongo")).toBeInTheDocument();
  });

  it("filters the list as the operator types and picks by click", async () => {
    const { onValueChange, user } = open();
    await user.click(screen.getByRole("button"));

    const search = screen.getByPlaceholderText(/search by mix/i);
    await user.type(search, "downy");

    expect(screen.getByText("Downy Mildew Mix")).toBeInTheDocument();
    expect(screen.queryByText("Botrytis Mix")).toBeNull();

    await user.click(screen.getByText("Downy Mildew Mix"));
    expect(onValueChange).toHaveBeenCalledWith("BOM-Th/xyz-004");
  });

  it("finds a tank mix by its code, not just its mix name", async () => {
    const { onValueChange, user } = open();
    await user.click(screen.getByRole("button"));
    await user.type(screen.getByPlaceholderText(/search by mix/i), "fcm-902");

    expect(screen.getByText("Botrytis Heavy")).toBeInTheDocument();
    expect(screen.queryByText("Botrytis Mix")).toBeNull();

    await user.click(screen.getByText("Botrytis Heavy"));
    expect(onValueChange).toHaveBeenCalledWith("BOM-Th/fcm-902");
  });

  it("picks the highlighted row on Enter after arrowing down", async () => {
    const { onValueChange, user } = open();
    await user.click(screen.getByRole("button"));
    await user.type(screen.getByPlaceholderText(/search by mix/i), "botrytis");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("BOM-Th/fcm-902");
  });

  it("tells the operator when results are truncated", async () => {
    const many: BomOption[] = Array.from(
      { length: MAX_RENDERED_BOMS + 12 },
      (_, i) => ({ name: `BOM-${i}`, item_name: `Mix ${i}` }),
    );
    const { user } = open({ boms: many });
    await user.click(screen.getByRole("button"));

    expect(
      screen.getByText(/showing 50 — refine your search/i),
    ).toBeInTheDocument();
  });

  it("reports an empty search rather than rendering a blank list", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button"));
    await user.type(screen.getByPlaceholderText(/search by mix/i), "zzz-nothing");

    expect(screen.getByText(/No BOM matches/i)).toBeInTheDocument();
  });
});
