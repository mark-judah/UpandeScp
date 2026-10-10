import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchObservationGallery = vi.fn();
vi.mock("@/lib/gallery-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gallery-api")>()),
  fetchObservationGallery: (...a: unknown[]) => fetchObservationGallery(...a),
}));

import { GalleryScopeProvider, ObservationName } from "../ObservationGallery";
import type { GalleryPayload, GalleryPhoto } from "@/lib/gallery-api";

const scope = { crop: "Rose", from_date: "2031-12-01", to_date: "2031-12-07", farm: "", greenhouse: "" };

function photo(i: number): GalleryPhoto {
  return {
    image: `/private/files/p${i}.jpg`, caption: `cap ${i}`, capturedOn: `2031-12-0${(i % 7) + 1} 08:00:00`,
    scout: "100063", scoutName: "Jane Scout", house: "Chepsito GH 01 - KR", date: "2031-12-01", entry: `SE-${i}`,
  };
}

const pest: GalleryPayload = {
  kind: "pest", name: "Thrips", showCount: true,
  reference: {
    commonName: "Thrips", scientificName: "Frankliniella occidentalis",
    guideline: "Tiny slender insects", image: "/files/thrips.jpg",
  },
  scouts: [
    { scout: "100063", scoutName: "Jane Scout", entries: 12, stations: 9, count: 31, houses: 2, lastSeen: "2031-12-06" },
  ],
  photos: Array.from({ length: 24 }, (_, i) => photo(i)),
  photosPage: 0,
  photosHasMore: true,
};

function renderName(kind: "pest" | "disease" = "pest", name = "Thrips") {
  return render(
    <GalleryScopeProvider scope={scope}>
      <ObservationName kind={kind} name={name} />
    </GalleryScopeProvider>,
  );
}

beforeEach(() => {
  fetchObservationGallery.mockReset();
});

describe("ObservationGallery", () => {
  it("renders a plain name outside a gallery scope", () => {
    render(<ObservationName kind="pest" name="Thrips" />);
    expect(screen.getByText("Thrips").tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the pop-up with the reference, the by-scout table and photos", async () => {
    fetchObservationGallery.mockResolvedValueOnce(pest);
    renderName();
    fireEvent.click(screen.getByRole("button", { name: /Thrips/ }));
    expect(fetchObservationGallery).toHaveBeenCalledWith(scope, "pest", "Thrips", 0);
    expect(await screen.findByText("Frankliniella occidentalis")).toBeInTheDocument();
    expect(screen.getByText("Tiny slender insects")).toBeInTheDocument();
    expect(screen.getByAltText(/Thrips reference/)).toHaveAttribute("src", "/files/thrips.jpg");
    const table = screen.getByTestId("gallery-scouts");
    expect(within(table).getByText("Count")).toBeInTheDocument();
    expect(within(table).getByText("Jane Scout")).toBeInTheDocument();
    expect(within(table).getByText("31")).toBeInTheDocument();
    const tiles = screen.getAllByTestId("gallery-photo");
    expect(tiles).toHaveLength(24);
    expect(within(tiles[0]).getByRole("link")).toHaveAttribute("href", "/private/files/p0.jpg");
    expect(tiles[0]).toHaveTextContent("cap 0");
    expect(tiles[0]).toHaveTextContent("Chepsito GH 01 - KR");
  });

  it("loads more photos on demand", async () => {
    fetchObservationGallery
      .mockResolvedValueOnce(pest)
      .mockResolvedValueOnce({ ...pest, photos: [photo(30)], photosPage: 1, photosHasMore: false });
    renderName();
    fireEvent.click(screen.getByRole("button", { name: /Thrips/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Load more/ }));
    expect(fetchObservationGallery).toHaveBeenLastCalledWith(scope, "pest", "Thrips", 1);
    expect(await screen.findByText("cap 30")).toBeInTheDocument();
    expect(screen.getAllByTestId("gallery-photo")).toHaveLength(25);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("a disease has no count column, and no photos shows the empty state", async () => {
    fetchObservationGallery.mockResolvedValueOnce({
      ...pest, kind: "disease", name: "Botrytis", showCount: false,
      reference: { commonName: "Botrytis", scientificName: "", guideline: "", image: "" },
      scouts: [{ ...pest.scouts[0], count: null }], photos: [], photosHasMore: false,
    });
    renderName("disease", "Botrytis");
    fireEvent.click(screen.getByRole("button", { name: /Botrytis/ }));
    const table = await screen.findByTestId("gallery-scouts");
    expect(within(table).queryByText("Count")).toBeNull();
    expect(screen.getByText(/No photos yet/)).toHaveTextContent(
      "Settings → Spray plan → Scouting capture",
    );
  });

  it("a nested scope narrows the parent's (the greenhouse modal)", async () => {
    fetchObservationGallery.mockResolvedValueOnce(pest);
    render(
      <GalleryScopeProvider scope={scope}>
        <GalleryScopeProvider scope={{ greenhouse: "GH 7" }}>
          <ObservationName kind="pest" name="Thrips" />
        </GalleryScopeProvider>
      </GalleryScopeProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Thrips/ }));
    expect(fetchObservationGallery).toHaveBeenCalledWith({ ...scope, greenhouse: "GH 7" }, "pest", "Thrips", 0);
  });

  it("shows the server's error", async () => {
    fetchObservationGallery.mockRejectedValueOnce(new Error("Unknown crop"));
    renderName();
    fireEvent.click(screen.getByRole("button", { name: /Thrips/ }));
    expect(await screen.findByText(/Unknown crop/)).toBeInTheDocument();
  });
});
