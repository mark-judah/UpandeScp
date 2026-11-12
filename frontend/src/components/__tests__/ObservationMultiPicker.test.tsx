import { useState } from "react";
import { render, screen } from "@testing-library/react";
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
const dot = (name: string) => screen.getByRole("checkbox", { name });
const rowOf = (name: string) => screen.getByText(name).closest("[data-row]") as HTMLElement;
async function open() {
  await userEvent.click(pill());
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
    await open();
    expect(dot("Pests")).toHaveAttribute("aria-checked", "true");
    expect(dot("Diseases")).toHaveAttribute("aria-checked", "true");
    const thrips = rowOf("Thrips");
    expect(thrips).toHaveTextContent("9");
    expect(thrips.querySelector("span.rounded-full")).toHaveStyle({ background: "#3366cc" });
    expect(screen.getByText("4 selected")).toBeTruthy();
  });

  it("Deselect all and Select all", async () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(spy.mock.lastCall![0].size).toBe(0);
    expect(pill()).toHaveTextContent("None selected");
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(spy.mock.lastCall![0].size).toBe(4);
  });

  it("a group follows its items and toggles them all", async () => {
    render(<Harness />);
    await open();
    await userEvent.click(screen.getByText("Mites"));
    expect(dot("Pests")).toHaveAttribute("aria-checked", "mixed");
    expect(pill()).toHaveTextContent("3 selected");
    await userEvent.click(screen.getByText("Pests")); // mixed -> all
    expect(dot("Pests")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByText("Pests")); // all -> none, diseases untouched
    expect(dot("Pests")).toHaveAttribute("aria-checked", "false");
    expect(dot("Diseases")).toHaveAttribute("aria-checked", "true");
    expect(pill()).toHaveTextContent("2 selected");
  });

  it("searches and says when nothing matches", async () => {
    render(<Harness start={new Set()} />);
    await open();
    await userEvent.type(screen.getByPlaceholderText("Search pests and diseases"), "rot");
    expect(screen.queryByText("Thrips")).toBeNull();
    expect(screen.getByText("Root rot")).toBeInTheDocument();
  });

  it("searching then Enter ticks the first match", async () => {
    const spy = vi.fn();
    render(<Harness start={new Set()} spy={spy} />);
    await open();
    await userEvent.type(screen.getByPlaceholderText("Search pests and diseases"), "mite{Enter}");
    expect([...spy.mock.lastCall![0]]).toEqual(["pest|Mites"]);
  });
});
