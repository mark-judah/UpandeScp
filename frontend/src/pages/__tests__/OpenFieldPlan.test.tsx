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
              classification: "Curative", reason: "", team: "T", kit: "", bom: "BOM-1", targets: [], area: "",
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

import { ToastProvider } from "@/components/Toast";
import { OpenFieldPlan } from "@/pages/OpenFieldPlan";

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

describe("OpenFieldPlan", () => {
  it("selects two blocks, plans each, and creates one draft per block together", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><OpenFieldPlan initialCrop="Potato" /></ToastProvider>);
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
