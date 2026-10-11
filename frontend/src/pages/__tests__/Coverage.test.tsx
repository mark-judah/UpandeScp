import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn(() => ({
  data: { marker: 1 }, loading: false, error: null, progress: null, reload: vi.fn(),
}));
const dataQualityTab = vi.fn((_p: { data: unknown }) => <div>data quality view</div>);

vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...(a as [])),
}));
vi.mock("@/hooks/use-crop-farms", () => ({ useCropFarms: () => ({ farms: { Chepsito: [] }, loading: false }) }));
vi.mock("@/pages/dashboard/DataQualityTab", () => ({
  DataQualityTab: (p: { data: unknown }) => dataQualityTab(p),
}));

const { Coverage } = await import("@/pages/Coverage");

describe("Reports ▸ Coverage", () => {
  it("renders the unchanged DataQualityTab on the quality aggregate", () => {
    const { getByText, getByRole } = render(<Coverage initialCrop="Rose" />);
    expect(getByRole("heading", { name: "Coverage" })).toBeInTheDocument();
    expect(getByText("data quality view")).toBeInTheDocument();
    const call = useDashboardAggregate.mock.calls[0] as unknown[];
    expect(call[0]).toBe("quality");
    expect(call[1]).toMatchObject({ crop: "Rose", farm: "", greenhouse: "" });
    expect(call[2]).toBe(true);
    expect(dataQualityTab.mock.calls[0][0].data).toEqual({ marker: 1 });
  });
});
