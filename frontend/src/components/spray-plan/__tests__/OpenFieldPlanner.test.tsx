import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchOpenFieldBlocks = vi.fn();
const fetchBlockFindings = vi.fn();
const createDraftPlansBatch = vi.fn();
vi.mock("@/lib/open-field-api", () => ({
  fetchOpenFieldBlocks: (...a: unknown[]) => fetchOpenFieldBlocks(...a),
  fetchBlockFindings: (...a: unknown[]) => fetchBlockFindings(...a),
  createDraftPlansBatch: (...a: unknown[]) => createDraftPlansBatch(...a),
}));
vi.mock("@/lib/spray-plan-creator-api", () => ({
  fetchCreatorBootstrap: vi.fn().mockResolvedValue({ spray_teams: [], kits: [], tank_mixes: [], farm_stores: {}, pest_catalog: [], disease_catalog: [] }),
}));
vi.mock("@/components/spray-plan/DraftBatchPanel", () => ({ DraftBatchPanel: () => <div data-testid="drafts" /> }));
// The panel is covered by its own test; here it just completes plans on demand.
vi.mock("@/components/spray-plan/BlockPlanPanel", () => ({
  BlockPlanPanel: (p: any) => (
    <div>
      {p.blocks.map((b: any) => (
        <button
          key={b.name}
          onClick={() =>
            p.onPlanChange(b.name, {
              classification: "Curative", reason: "", team: "T", kit: "", bom: "BOM-1", targets: ["Thrips"], area: "",
              chemicals: [{ item_code: "X", rate: 1, source: "S" }],
            })
          }
        >
          complete {b.label}
        </button>
      ))}
    </div>
  ),
}));

import { useState } from "react";
import { ToastProvider } from "@/components/Toast";
import { OpenFieldPlanner } from "@/components/spray-plan/OpenFieldPlanner";

/** The planner's selection belongs to its page (the Application Plan): hold it here. */
function Page({ crop = "Avocado" }: { crop?: string }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <OpenFieldPlanner crop={crop} selected={selected} onSelect={setSelected} />;
}

const blk = (n: string) => ({ name: `${n} - KL`, label: n, farm: "Lokitela", crop: "Avocado", crop_label: "Avocado", area_ha: 2, cost_center: `${n} - KL` });

beforeEach(() => {
  fetchOpenFieldBlocks.mockReset().mockResolvedValue({
    groups: [{ kind: "Section", name: "Section 1 - KL", label: "Section 1", blocks: [blk("S1-B1"), blk("S1-B2")] }],
  });
  fetchBlockFindings.mockReset().mockResolvedValue({});
  createDraftPlansBatch.mockReset().mockResolvedValue({
    results: [{ block: "S1-B1 - KL", work_order: "WO-1", warnings: [] }, { block: "S1-B2 - KL", work_order: "WO-2", warnings: [] }],
  });
});

describe("OpenFieldPlanner", () => {
  it("selects two blocks, plans each, and creates one draft per block together", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Page /></ToastProvider>);
    await user.click(await screen.findByRole("checkbox", { name: "Select all of Section 1" }));
    const create = await screen.findByRole("button", { name: /Create 2 draft plans/ });
    expect(create).toBeDisabled();
    await user.click(screen.getByText("complete S1-B1"));
    expect(create).toBeDisabled();
    await user.click(screen.getByText("complete S1-B2"));
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(createDraftPlansBatch).toHaveBeenCalledTimes(1));
    const payloads = createDraftPlansBatch.mock.calls[0][0];
    expect(payloads.map((p: any) => p.custom_greenhouse)).toEqual(["S1-B1 - KL", "S1-B2 - KL"]);
    expect(payloads[0].custom_area).toBe(2);
    expect(await screen.findByText(/2 draft plans created/)).toBeInTheDocument();
  });
});

describe("OpenFieldPlanner list", () => {
  it("lists the route crop's blocks and shows each block's extra cell", async () => {
    render(
      <ToastProvider>
        <OpenFieldPlanner crop="Avocado" selected={[]} onSelect={() => {}} rowExtra={(b) => <span data-testid={`heat-${b.label}`}>h</span>} />
      </ToastProvider>,
    );
    expect(await screen.findByTestId("heat-S1-B1")).toBeInTheDocument();
    expect(fetchOpenFieldBlocks).toHaveBeenCalledWith("Avocado");
  });
  it("brings a block picked elsewhere into view in the list", async () => {
    const many = Array.from({ length: 30 }, (_, i) => blk(`S1-B${i + 1}`));
    fetchOpenFieldBlocks.mockResolvedValue({ groups: [{ kind: "Section", name: "Section 1 - KL", label: "Section 1", blocks: many }] });
    const { rerender } = render(<ToastProvider><OpenFieldPlanner crop="Avocado" selected={[]} onSelect={() => {}} /></ToastProvider>);
    await screen.findByText("S1-B30");
    const box = screen.getByTestId("block-multi-picker").querySelector(".overflow-y-auto") as HTMLElement;
    const rows = Array.from(box.querySelectorAll<HTMLElement>("[data-block]"));
    rows.forEach((r, i) => Object.defineProperty(r, "offsetTop", { value: i * 30, configurable: true }));
    rows.forEach((r) => Object.defineProperty(r, "offsetHeight", { value: 30, configurable: true }));
    Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(box, "offsetTop", { value: 0, configurable: true });
    rerender(<ToastProvider><OpenFieldPlanner crop="Avocado" selected={["S1-B30 - KL"]} onSelect={() => {}} focus="S1-B30 - KL" /></ToastProvider>);
    await waitFor(() => expect(box.scrollTop).toBeGreaterThan(0));
  });
});
