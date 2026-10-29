import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockSelect } from "@/components/BlockSelect";

const crops = {
  "P1-B1 - MUT": { crop: "Potato", crop_label: "Potato", group: "Pivot 1 - MUT" },
  "P1-B2 - MUT": { crop: "Onion", crop_label: "Onion", group: "Pivot 1 - MUT" },
  "Avocado Block A - MUT": { crop: "Avocado", crop_label: "Avocado", group: "Section A - MUT" },
};

function open(value = "") {
  const onChange = vi.fn();
  render(
    <BlockSelect label="Block for patches" placeholder="Pick a block" value={value} onChange={onChange}
      options={Object.keys(crops)} crops={crops} />,
  );
  return { onChange, user: userEvent.setup() };
}

describe("BlockSelect", () => {
  it("names the crop beside each block of a pivot, highlighted", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Block for patches" }));
    const row = screen.getByRole("option", { name: /P1-B1/ });
    expect(within(row).getByTestId("crop-chip")).toHaveTextContent("Potato");
    expect(within(screen.getByRole("option", { name: /P1-B2/ })).getByTestId("crop-chip")).toHaveTextContent("Onion");
  });

  it("groups blocks under their pivot or section", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Block for patches" }));
    expect(screen.getByText("Pivot 1")).toBeInTheDocument();
    expect(screen.getByText("Section A")).toBeInTheDocument();
  });

  it("picks a block and shows its crop on the pill", async () => {
    const { user, onChange } = open();
    await user.click(screen.getByRole("button", { name: "Block for patches" }));
    await user.click(screen.getByRole("option", { name: /P1-B2/ }));
    expect(onChange).toHaveBeenCalledWith("P1-B2 - MUT");
  });

  it("the pill carries the crop of the chosen block", () => {
    open("P1-B1 - MUT");
    expect(within(screen.getByRole("button", { name: "Block for patches" })).getByTestId("crop-chip")).toHaveTextContent("Potato");
  });

  it("works with no crop data (a block with none shows no chip)", async () => {
    const onChange = vi.fn();
    render(<BlockSelect label="Block" placeholder="Pick" value="" onChange={onChange} options={["X - MUT"]} crops={{}} />);
    await userEvent.click(screen.getByRole("button", { name: "Block" }));
    expect(screen.queryByTestId("crop-chip")).toBeNull();
  });
});
