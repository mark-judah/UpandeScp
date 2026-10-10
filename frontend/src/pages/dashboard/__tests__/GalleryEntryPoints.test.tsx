import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchObservationGallery = vi.fn();
vi.mock("@/lib/gallery-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gallery-api")>()),
  fetchObservationGallery: (...a: unknown[]) => fetchObservationGallery(...a),
}));
const useDashboardAggregate = vi.fn();
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));

import { GalleryScopeProvider } from "@/components/gallery/ObservationGallery";
import { PestsTab } from "../PestsTab";
import { DiseasesTab } from "../DiseasesTab";
import { GreenhouseModal } from "../GreenhouseModal";
import type { DiseasesPayload, PestsPayload } from "../pests-diseases-types";

const scope = { crop: "Rose", from_date: "2031-12-01", to_date: "2031-12-07", farm: "", greenhouse: "" };
const payload = (name: string) => ({
  kind: "pest", name, showCount: true,
  reference: { commonName: name, scientificName: "Sci name", guideline: "", image: "" },
  scouts: [], photos: [], photosPage: 0, photosHasMore: false,
});
const row = (name: string) => ({
  name, total: 4, high: 1, moderate: 1, low: 2,
  margin: null, sections_scouted: 0, sections_total: 0, reliability: "Fair" as const, reason: null, prev: null,
});
const base = {
  ranking: [], distribution: [], sectionSplit: [], greenhousePressure: [], dailyPercent: [],
  trendSeries: { rows: [], keys: [] },
};

beforeEach(() => {
  fetchObservationGallery.mockReset().mockImplementation((_s, kind, name) =>
    Promise.resolve({ ...payload(name), kind }));
});

describe("gallery entry points (G1)", () => {
  it("the Pests tab ranking opens the pest gallery for the dashboard scope", async () => {
    const data = { ...base, ranking: [row("Thrips")],
      filterOptions: { pests: ["Thrips"], sections: [], stages: [] } } as unknown as PestsPayload;
    render(
      <GalleryScopeProvider scope={scope}>
        <PestsTab data={data} pestName="" section="" stage="" onFiltersChange={() => {}} />
      </GalleryScopeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thrips — open gallery/ }));
    expect(fetchObservationGallery).toHaveBeenCalledWith(scope, "pest", "Thrips", 0);
    expect(await screen.findByText("Sci name")).toBeInTheDocument();
  });

  it("the Diseases tab ranking opens the disease gallery", () => {
    const data = { ...base, ranking: [row("Botrytis")],
      filterOptions: { diseases: ["Botrytis"], sections: [], stages: [] } } as unknown as DiseasesPayload;
    render(
      <GalleryScopeProvider scope={scope}>
        <DiseasesTab data={data} diseaseName="" section="" stage="" onFiltersChange={() => {}} />
      </GalleryScopeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Botrytis — open gallery/ }));
    expect(fetchObservationGallery).toHaveBeenCalledWith(scope, "disease", "Botrytis", 0);
  });

  it("the greenhouse modal's top pests and diseases open the gallery for that house", () => {
    useDashboardAggregate.mockReset().mockReturnValue({
      data: { topPests: [{ name: "Thrips", count: 9 }], topDiseases: [{ name: "Downy Mildew", count: 3 }],
        traps: [], daily: [], scouts: 1, alerts: 0, prevalence: [] },
    });
    render(<GreenhouseModal greenhouse="GH 7" fromDate="2031-12-01" toDate="2031-12-07" crop="Rose" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Downy Mildew — open gallery/ }));
    expect(fetchObservationGallery).toHaveBeenCalledWith(
      { ...scope, greenhouse: "GH 7" }, "disease", "Downy Mildew", 0);
  });
});
