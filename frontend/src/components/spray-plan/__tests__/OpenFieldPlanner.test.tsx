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
    <div data-show-errors={p.showErrors ? "true" : "false"} data-testid="panel">
      {p.blocks.map((b: any) => (
        <span key={`x-${b.name}`}>
          <button onClick={() => p.onJump?.(b.name)}>jump {b.label}</button>
          <button onClick={() => p.onRemove?.(b.name)}>remove {b.label}</button>
        </span>
      ))}
      {p.blocks.map((b: any) => (
        <button
          key={b.name}
          onClick={() =>
            p.onPlanChange(b.name, {
              classification: "Curative", reason: "", team: "T", kit: "", bom: "BOM-1", targets: ["Thrips"], area: "",
              chemicals: b.label === (window as any).__shortBlock
                ? [{ item_code: "X", item_name: "Xchem", basis: "Water", rate: 5, source: "S", stock_free: 1 }]
                : [{ item_code: "X", rate: 1, source: "S" }],
              water: "1000",
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
function Page({ crop = "Potato", onFocusBlock }: { crop?: string; onFocusBlock?: (b: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return <OpenFieldPlanner crop={crop} selected={selected} onSelect={setSelected} onFocusBlock={onFocusBlock} />;
}

const blk = (n: string) => ({ name: `${n} - MUT`, label: n, farm: "Mutara", crop: "Potato", crop_label: "Potato", area_ha: 2, cost_center: `${n} - MUT` });

beforeEach(() => {
  fetchOpenFieldBlocks.mockReset().mockResolvedValue({
    groups: [{ kind: "Pivot", name: "Pivot 1 - MUT", label: "Pivot 1", blocks: [blk("P1-B1"), blk("P1-B2")] }],
  });
  fetchBlockFindings.mockReset().mockResolvedValue({});
  createDraftPlansBatch.mockReset().mockResolvedValue({
    results: [{ block: "P1-B1 - MUT", work_order: "WO-1", warnings: [] }, { block: "P1-B2 - MUT", work_order: "WO-2", warnings: [] }],
  });
});

describe("OpenFieldPlanner", () => {
  it("selects two blocks, plans each, and creates one draft per block together", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Page /></ToastProvider>);
    await user.click(await screen.findByRole("checkbox", { name: "Select all of Pivot 1" }));
    const create = await screen.findByRole("button", { name: /Create 2 draft plans/ });
    expect(create).toBeDisabled();
    await user.click(screen.getByText("complete P1-B1"));
    expect(create).toBeDisabled();
    await user.click(screen.getByText("complete P1-B2"));
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(createDraftPlansBatch).toHaveBeenCalledTimes(1));
    const payloads = createDraftPlansBatch.mock.calls[0][0];
    expect(payloads.map((p: any) => p.custom_greenhouse)).toEqual(["P1-B1 - MUT", "P1-B2 - MUT"]);
    expect(payloads[0].custom_area).toBe(2);
    expect(await screen.findByText(/2 draft plans created/)).toBeInTheDocument();
  });
});

describe("OpenFieldPlanner stock gate", () => {
  it("refuses the batch while any block is short on stock", async () => {
    (window as any).__shortBlock = "P1-B2";
    try {
      const user = userEvent.setup();
      render(<ToastProvider><Page /></ToastProvider>);
      await user.click(await screen.findByRole("checkbox", { name: "Select all of Pivot 1" }));
      const create = await screen.findByRole("button", { name: /Create 2 draft plans/ });
      await user.click(screen.getByText("complete P1-B1"));
      await user.click(screen.getByText("complete P1-B2"));
      expect(create).toBeDisabled();
      expect(screen.getByText(/Still to plan: P1-B2$/)).toBeInTheDocument();
    } finally {
      delete (window as any).__shortBlock;
    }
  });
});

describe("OpenFieldPlanner jump, remove, submit attempt", () => {
  it("Jump to block hands the block to the page, and the X takes it out of the selection", async () => {
    const onFocusBlock = vi.fn();
    const user = userEvent.setup();
    render(<ToastProvider><Page onFocusBlock={onFocusBlock} /></ToastProvider>);
    await user.click(await screen.findByRole("checkbox", { name: "Select all of Pivot 1" }));
    await user.click(await screen.findByText("jump P1-B2"));
    expect(onFocusBlock).toHaveBeenCalledWith("P1-B2 - MUT");
    await user.click(screen.getByText("remove P1-B1"));
    expect(await screen.findByRole("button", { name: /Create 1 draft plan$/ })).toBeInTheDocument();
    expect(screen.queryByText("remove P1-B1")).toBeNull();
  });

  it("trying to submit an incomplete batch outlines the missing fields and sends nothing", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><Page /></ToastProvider>);
    await user.click(await screen.findByRole("checkbox", { name: "Select all of Pivot 1" }));
    expect(screen.getByTestId("panel")).toHaveAttribute("data-show-errors", "false");
    await user.click(await screen.findByTestId("create-attempt"));
    expect(screen.getByTestId("panel")).toHaveAttribute("data-show-errors", "true");
    expect(createDraftPlansBatch).not.toHaveBeenCalled();
  });
});

describe("OpenFieldPlanner list", () => {
  it("lists the route crop's blocks and shows each block's extra cell", async () => {
    render(
      <ToastProvider>
        <OpenFieldPlanner crop="Potato" selected={[]} onSelect={() => {}} rowExtra={(b) => <span data-testid={`heat-${b.label}`}>h</span>} />
      </ToastProvider>,
    );
    expect(await screen.findByTestId("heat-P1-B1")).toBeInTheDocument();
    expect(fetchOpenFieldBlocks).toHaveBeenCalledWith("Potato");
  });
  it("brings a block picked elsewhere into view in the list", async () => {
    const many = Array.from({ length: 30 }, (_, i) => blk(`P1-B${i + 1}`));
    fetchOpenFieldBlocks.mockResolvedValue({ groups: [{ kind: "Pivot", name: "Pivot 1 - MUT", label: "Pivot 1", blocks: many }] });
    const { rerender } = render(<ToastProvider><OpenFieldPlanner crop="Potato" selected={[]} onSelect={() => {}} /></ToastProvider>);
    await screen.findByText("P1-B30");
    const box = screen.getByTestId("block-multi-picker").querySelector(".overflow-y-auto") as HTMLElement;
    const rows = Array.from(box.querySelectorAll<HTMLElement>("[data-block]"));
    rows.forEach((r, i) => Object.defineProperty(r, "offsetTop", { value: i * 30, configurable: true }));
    rows.forEach((r) => Object.defineProperty(r, "offsetHeight", { value: 30, configurable: true }));
    Object.defineProperty(box, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(box, "offsetTop", { value: 0, configurable: true });
    rerender(<ToastProvider><OpenFieldPlanner crop="Potato" selected={["P1-B30 - MUT"]} onSelect={() => {}} focus="P1-B30 - MUT" /></ToastProvider>);
    await waitFor(() => expect(box.scrollTop).toBeGreaterThan(0));
  });
});
