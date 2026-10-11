import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const cycles = deferred<unknown[]>();
const requirement = deferred<unknown>();

vi.mock("@/lib/loaning-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loaning-api")>()),
  fetchMyFarms: async () => ({ farms: ["Chepsito"], enabled: true }),
}));
vi.mock("@/lib/procurement-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/procurement-api")>()),
  listCycles: () => cycles.promise,
  myRequirement: () => requirement.promise,
}));

const { Procurement } = await import("@/pages/Procurement");

describe("Procurement — in-place skeletons", () => {
  it("keeps the frame up and never guesses 'No cycle open' while loading", async () => {
    const { container } = render(<Procurement />);

    expect(screen.getByRole("heading", { name: "Chemical Procurement" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "My requirement" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General store" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Chemical" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Quantity" })).toBeInTheDocument();
    expect(screen.queryByText("No cycle open")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-skeleton="row"]').length).toBeGreaterThan(0);

    // The cycle lands; the requirement is still on the way — still a frame.
    await act(async () =>
      cycles.resolve([{ name: "PC-1", cycle_name: "October", status: "Open" }]),
    );
    expect(screen.getByText("October · Open")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "UOM" })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-skeleton="row"]').length).toBeGreaterThan(0);

    await act(async () =>
      requirement.resolve({
        name: "REQ-1", farm: "Chepsito", cycle: "PC-1", status: "Draft",
        items: [{ item_code: "CH-1", item_name: "Impulse", uom: "Litre", requested_qty: 4 }],
      }),
    );
    expect(screen.getByText("Impulse")).toBeInTheDocument();
    expect(container.querySelector('[data-skeleton="row"]')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
