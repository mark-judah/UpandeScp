import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastApi } from "@/components/Toast";

let api: ToastApi;
function Grab() {
  api = useToast();
  return null;
}
const mount = () =>
  render(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  );

describe("Toast (Livestock / Frappe desk alert style)", () => {
  afterEach(() => vi.useRealTimers());

  it("floats a toast with a hint, and a confirmation times out", () => {
    vi.useFakeTimers();
    mount();
    act(() => void api.show("Saved.", "ok", { hint: "It applies from tomorrow." }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved.It applies from tomorrow.");
    act(() => vi.advanceTimersByTime(5100));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an error never times out and is announced as an alert", () => {
    vi.useFakeTimers();
    mount();
    act(() => void api.show("Stock is short.", "err", { ms: 1000 }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("alert")).toHaveTextContent("Stock is short.");
  });

  it("a loading toast stays until its caller dismisses it", () => {
    vi.useFakeTimers();
    mount();
    let id = 0;
    act(() => void (id = api.show("Submitting…", "loading")));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Submitting…")).toBeInTheDocument();
    act(() => api.dismiss(id));
    expect(screen.queryByText("Submitting…")).toBeNull();
  });

  it("keeps at most three, dropping the oldest, and can be dismissed", async () => {
    mount();
    act(() => {
      for (const t of ["One.", "Two.", "Three.", "Four."]) api.show(t, "info");
    });
    expect(screen.queryByText("One.")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(3);
    await userEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(screen.queryByText("Two.")).toBeNull();
  });

  it("colours the fill and icon, never a strip down the edge", () => {
    mount();
    act(() => void api.show("Careful.", "warn"));
    const card = screen.getByRole("status");
    expect(card.getAttribute("style")).toContain("--sd-alert-warn");
    expect(card.outerHTML).not.toMatch(/border-l-|border-left/);
  });
});
