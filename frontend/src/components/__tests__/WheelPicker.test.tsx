import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WheelColumn } from "@/components/WheelPicker";
import { TimePicker } from "@/components/TimePicker";

function Wheel() {
  const [v, setV] = useState("b");
  return (
    <WheelColumn
      label="Letters"
      value={v}
      onChange={setV}
      options={["a", "b", { value: "c", disabled: true }, "d", "e"]}
    />
  );
}

describe("WheelColumn", () => {
  it("arrow keys skip disabled options and stop at the ends", async () => {
    const user = userEvent.setup();
    render(<Wheel />);
    const box = screen.getByRole("listbox", { name: "Letters" });
    box.focus();
    const cur = () => within(box).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")!.textContent;
    await user.keyboard("{ArrowDown}");
    expect(cur()).toBe("d");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(cur()).toBe("e");
    await user.keyboard("{Home}");
    expect(cur()).toBe("a");
  });

  it("is display-only (no listbox) without onChange", () => {
    render(<WheelColumn options={["01", "02"]} value="02" />);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("TimePicker (uses WheelColumn)", () => {
  it("still steps with its chevrons", async () => {
    const user = userEvent.setup();
    let out = "";
    render(<TimePicker value="06:00" label="Time" onChange={(v) => (out = v)} />);
    await user.click(screen.getByRole("button", { name: "Time" }));
    await user.click(screen.getByRole("button", { name: "Increase hour" }));
    expect(out).toBe("07:00");
  });
});
