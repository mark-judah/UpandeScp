import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#3366cc", disease: () => "#8b5cf6" }),
}));

import { ObservationMultiPicker, obsOptionKey, pillText } from "@/components/ObservationMultiPicker";
import type { ObsOption } from "@/lib/pest-heat";

const OPTS: ObsOption[] = [
  { kind: "pest", name: "Thrips", count: 9 },
  { kind: "pest", name: "Mites", count: 4 },
  { kind: "disease", name: "Anthracnose", count: 3 },
  { kind: "disease", name: "Root rot", count: 1 },
];
const ALL = new Set(OPTS.map(obsOptionKey));

function Harness({ start = ALL, spy }: { start?: Set<string>; spy?: (s: Set<string>) => void }) {
  const [v, setV] = useState<Set<string>>(start);
  return (
    <ObservationMultiPicker options={OPTS} value={v} onChange={(n) => { setV(n); spy?.(n); }} />
  );
}
const pill = () => screen.getByRole("button", { name: "Pests and diseases" });
async function open() {
  await userEvent.click(pill());
  return screen.getByRole("listbox", { name: "Pests and diseases" });
}

describe("pillText", () => {
  it("names all, one, or a count", () => {
    expect(pillText(OPTS, ALL)).toBe("All pests and diseases");
    expect(pillText(OPTS, new Set(["pest|Mites"]))).toBe("Mites");
    expect(pillText(OPTS, new Set(["pest|Mites", "pest|Thrips"]))).toBe("2 selected");
    expect(pillText(OPTS, new Set())).toBe("None selected");
    expect(pillText(OPTS.slice(0, 2), new Set(OPTS.slice(0, 2).map(obsOptionKey)))).toBe("All pests");
  });
});

describe("ObservationMultiPicker", () => {
  it("lists Pests and Diseases groups with items, colour dots and counts, all ticked", async () => {
    render(<Harness />);
    expect(pill()).toHaveTextContent("All pests and diseases");
    const list = await open();
    expect(within(list).getByRole("option", { name: "Select all" })).toHaveAttribute("aria-checked", "true");
    expect(within(list).getByRole("option", { name: "Pests, select all" })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: "Diseases, select all" })).toBeInTheDocument();
    const thrips = within(list).getByRole("option", { name: "Thrips" });
    expect(thrips).toHaveTextContent("9");
    expect(thrips.querySelector("span.rounded-full")).toHaveStyle({ background: "#3366cc" });
  });

  it("select all clears and refills everything", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const list = await open();
    await userEvent.click(within(list).getByRole("option", { name: "Select all" }));
    expect(spy.mock.lastCall![0].size).toBe(0);
    expect(pill()).toHaveTextContent("None selected");
    await userEvent.click(within(list).getByRole("option", { name: "Select all" }));
    expect(spy.mock.lastCall![0].size).toBe(4);
  });

  it("group select-all is tri-state", async () => {
    render(<Harness />);
    const list = await open();
    const pests = () => within(list).getByRole("option", { name: "Pests, select all" });
    expect(pests()).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(list).getByRole("option", { name: "Mites" }));
    expect(pests()).toHaveAttribute("aria-checked", "mixed");
    expect(within(list).getByRole("option", { name: "Select all" })).toHaveAttribute("aria-checked", "mixed");
    expect(pill()).toHaveTextContent("3 selected");
    // mixed -> all
    await userEvent.click(pests());
    expect(pests()).toHaveAttribute("aria-checked", "true");
    // all -> none, diseases untouched
    await userEvent.click(pests());
    expect(pests()).toHaveAttribute("aria-checked", "false");
    expect(within(list).getByRole("option", { name: "Diseases, select all" })).toHaveAttribute("aria-checked", "true");
    expect(pill()).toHaveTextContent("2 selected");
  });

  it("searches, hides select-all, and a group toggle acts on the matches only", async () => {
    const spy = vi.fn();
    render(<Harness start={new Set()} spy={spy} />);
    const list = await open();
    await userEvent.type(screen.getByRole("combobox"), "rot");
    expect(within(list).queryByRole("option", { name: "Select all" })).toBeNull();
    expect(within(list).queryByRole("option", { name: "Thrips" })).toBeNull();
    await userEvent.click(within(list).getByRole("option", { name: "Diseases, select all" }));
    expect([...spy.mock.lastCall![0]]).toEqual(["disease|Root rot"]);
    await userEvent.clear(screen.getByRole("combobox"));
    await userEvent.type(screen.getByRole("combobox"), "zzz");
    expect(screen.getByText("No match")).toBeInTheDocument();
  });

  it("keyboard: arrows move, Enter toggles, the list stays open", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    const list = await open();
    const box = screen.getByRole("combobox");
    await userEvent.type(box, "{ArrowDown}{ArrowDown}{ArrowDown}"); // all, Pests, Thrips
    expect(box).toHaveAttribute("aria-activedescendant", within(list).getByRole("option", { name: "Thrips" }).id);
    await userEvent.type(box, "{Enter}");
    expect(spy.mock.lastCall![0].has("pest|Thrips")).toBe(false);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.type(box, "{ArrowUp}{ArrowUp}{Enter}"); // Pests header -> select all pests again
    expect(spy.mock.lastCall![0].has("pest|Thrips")).toBe(true);
  });

  it("searching then Enter ticks the first match", async () => {
    const spy = vi.fn();
    render(<Harness start={new Set()} spy={spy} />);
    await open();
    await userEvent.type(screen.getByRole("combobox"), "mite{Enter}");
    expect([...spy.mock.lastCall![0]]).toEqual(["pest|Mites"]);
  });
});
