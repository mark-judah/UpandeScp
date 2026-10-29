import { createContext, useContext, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setCropProfiles } from "@/lib/crop-profile";
import type { FeedPayload, FeedPhoto } from "@/lib/gallery-api";

const fetchPhotoFeed = vi.fn();
vi.mock("@/lib/gallery-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/gallery-api")>()),
  fetchPhotoFeed: (...a: unknown[]) => fetchPhotoFeed(...a),
}));
vi.mock("@/hooks/use-crop-farms", () => ({
  useCropFarms: () => ({ farms: { Chepsito: ["GH1 - KR", "GH2 - KR"], Kaptumbo: ["GH9 - KR"] }, loading: false }),
}));
vi.mock("@/components/DatePicker", () => ({
  DatePicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input aria-label="date" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
// Radix Select does not drive in jsdom: a plain input stands in for the trigger.
const Sel = createContext<{ value: string; onValueChange: (v: string) => void } | null>(null);
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <Sel.Provider value={{ value, onValueChange }}>{children}</Sel.Provider>
  ),
  SelectTrigger: ({ "aria-label": label }: { "aria-label": string }) => {
    const c = useContext(Sel)!;
    return <input aria-label={label} value={c.value} onChange={(e) => c.onValueChange(e.target.value)} />;
  },
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div hidden>{children}</div>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <span data-value={value}>{children}</span>,
}));

const { Gallery, formatCapture } = await import("@/pages/Gallery");

function photo(i: number, over: Partial<FeedPhoto> = {}): FeedPhoto {
  return {
    image: `/private/files/p${i}.jpg`,
    caption: `caption ${i}`,
    capturedOn: "2026-10-01 08:05:00",
    scout: i % 2 ? "EMP-1" : "EMP-2",
    scoutName: i % 2 ? "Imelda Mutua" : "John Kip",
    scoutImage: i % 2 ? "/private/files/imelda.jpg" : "",
    house: "GH1 - KR",
    date: "2026-10-01",
    entry: `SE-${i}`,
    subject: i % 2 ? "Thrips" : "Powdery Mildew",
    kind: i % 2 ? "pest" : "disease",
    ...over,
  };
}

function page(photos: FeedPhoto[], more: boolean, n = 0): FeedPayload {
  return {
    photos, page: n, hasMore: more, pageSize: 24,
    facets: n === 0 ? {
      subjects: [{ name: "Thrips", kind: "pest", count: 2 }, { name: "Powdery Mildew", kind: "disease", count: 1 }],
      scouts: [{ scout: "EMP-1", scoutName: "Imelda Mutua", image: "/private/files/imelda.jpg", count: 2 }],
    } : undefined,
  };
}

beforeEach(() => {
  fetchPhotoFeed.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Scouting ▸ Gallery", () => {
  it("renders the masonry of tiles with photo, observation, house, scout and date", async () => {
    fetchPhotoFeed.mockResolvedValueOnce(page([photo(1), photo(2)], false));
    render(<Gallery initialCrop="Rose" />);
    const grid = await screen.findByTestId("gallery-masonry");
    expect(grid.className).toMatch(/columns-2/);
    const tiles = within(grid).getAllByTestId("gallery-tile");
    expect(tiles).toHaveLength(2);
    const t = within(tiles[0]);
    expect(t.getByAltText("caption 1")).toHaveAttribute("src", expect.stringContaining("thumb?src=%2Fprivate%2Ffiles%2Fp1.jpg&w=480"));
    expect(t.getByText("Thrips")).toBeInTheDocument();
    // no user names or avatars on the grid tiles
    expect(t.queryByText("Imelda Mutua")).toBeNull();
    expect(tiles[0].querySelector('img[src="/private/files/imelda.jpg"]')).toBeNull();
    expect(within(tiles[1]).queryByText("JK")).toBeNull();
    expect(t.getByText("GH1")).toBeInTheDocument();
    expect(t.getByText("1 Oct 2026")).toBeInTheDocument();
    expect(fetchPhotoFeed.mock.calls[0][0]).toMatchObject({ crop: "Rose", farm: "", kind: "", name: "", scout: "" });
  });

  it("refetches page 0 with the chosen filters", async () => {
    fetchPhotoFeed.mockResolvedValue(page([photo(1)], false));
    render(<Gallery initialCrop="Rose" />);
    await screen.findByTestId("gallery-masonry");
    // The place picker: one pill, a farm row then a house row.
    fireEvent.click(screen.getByRole("button", { name: "Visual findings place" }));
    fireEvent.click(await screen.findByRole("option", { name: "Chepsito" }));
    await waitFor(() => expect(fetchPhotoFeed).toHaveBeenLastCalledWith(expect.objectContaining({ farm: "Chepsito" }), 0));
    fireEvent.click(screen.getByRole("button", { name: "Visual findings place" }));
    fireEvent.click(await screen.findByRole("option", { name: "GH2" }));
    fireEvent.change(screen.getByLabelText("Gallery kind"), { target: { value: "pest" } });
    fireEvent.change(screen.getByLabelText("Gallery observation"), { target: { value: "Thrips" } });
    fireEvent.change(screen.getByLabelText("Gallery scout"), { target: { value: "EMP-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Gallery date range" }));
    // Picking is the only way in (no typed boxes): use the "Last 14 days" preset.
    fireEvent.click(screen.getByRole("button", { name: "Last 14 days" }));
    const t = new Date();
    t.setDate(t.getDate() - 13);
    const wantFrom = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    await waitFor(() =>
      expect(fetchPhotoFeed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          farm: "Chepsito", greenhouse: "GH2 - KR", kind: "pest", name: "Thrips", scout: "EMP-1", from_date: wantFrom,
        }),
        0,
      ),
    );
  });

  it("loads more with the button and on scroll", async () => {
    let onIntersect: ((es: Array<{ isIntersecting: boolean }>) => void) | null = null;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: typeof onIntersect) { onIntersect = cb; }
      observe() {}
      disconnect() {}
    });
    fetchPhotoFeed
      .mockResolvedValueOnce(page([photo(1), photo(2)], true))
      .mockResolvedValueOnce(page([photo(3)], true, 1))
      .mockResolvedValueOnce(page([photo(4)], false, 2));
    render(<Gallery initialCrop="Rose" />);
    await screen.findByTestId("gallery-masonry");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByTestId("gallery-tile")).toHaveLength(3));
    expect(fetchPhotoFeed.mock.calls[1][1]).toBe(1);
    await act(async () => onIntersect!([{ isIntersecting: true }]));
    await waitFor(() => expect(screen.getAllByTestId("gallery-tile")).toHaveLength(4));
    expect(fetchPhotoFeed.mock.calls[2][1]).toBe(2);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("opens a lightbox with details and steps prev/next, loading the next page at the end", async () => {
    fetchPhotoFeed
      .mockResolvedValueOnce(page([photo(1), photo(2)], true))
      .mockResolvedValueOnce(page([photo(3)], false, 1));
    render(<Gallery initialCrop="Rose" />);
    await screen.findByTestId("gallery-masonry");
    fireEvent.click(screen.getByRole("button", { name: /Open photo: Thrips/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("lightbox-scout")).toHaveTextContent("Imelda Mutua");
    expect(within(dialog).getByText("1 Oct 2026 · 08:05")).toBeInTheDocument();
    expect(within(dialog).getByText(/1 of 2+/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Open scouting entry/ })).toHaveAttribute("href", "/app/scouting-entry/SE-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next photo" }));
    expect(within(dialog).getByTestId("lightbox-scout")).toHaveTextContent("John Kip");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(dialog).getByTestId("lightbox-scout")).toHaveTextContent("Imelda Mutua");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next photo" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next photo" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(/3 of 3/)).toBeInTheDocument());
    expect(fetchPhotoFeed.mock.calls[1][1]).toBe(1);
  });

  it("opens the floating right-hand panel with who, where, when and what; Esc closes", async () => {
    fetchPhotoFeed.mockResolvedValueOnce(page([photo(1, {
      farm: "Chepsito", greenhouse: "GH1 - KR", bed: "4", time: "08:05", stage: "Adult", count: 6,
      trap: "Chepsito - 101", trapLocation: "Indoor", trapCount: 5, notes: "DEMO trap catch",
    })], false));
    render(<Gallery initialCrop="Rose" />);
    await screen.findByTestId("gallery-masonry");
    fireEvent.click(screen.getByRole("button", { name: /Open photo: Thrips/ }));
    const panel = await screen.findByTestId("finding-panel");
    expect(panel.className).toMatch(/fixed/);
    expect(panel.className).toMatch(/right-4/);
    // the grid makes room for the panel at md+, and the panel image is the 960 thumb
    expect(screen.getByTestId("gallery-content").className).toContain("md:pr-[calc(380px+2rem)]");
    const big = within(panel).getByRole("button", { name: "View photo full size" }).querySelector("img")!;
    expect(big.getAttribute("src")).toContain("&w=960");
    expect(big.getAttribute("srcset")).toMatch(/w=960 960w, .*w=1600 1600w/);
    const w = within(panel);
    expect(w.getByTestId("lightbox-scout")).toHaveTextContent("Imelda Mutua");
    expect(w.getByTestId("finding-where")).toHaveTextContent("GH1 · Bed 4");
    expect(w.getByText(/Bed 4/)).toBeInTheDocument();
    expect(w.getByText(/Chepsito - 101/)).toBeInTheDocument();
    expect(w.getByTestId("finding-when")).toHaveTextContent("1 Oct 2026 · 08:05");
    expect(w.getByText("Highest count")).toBeInTheDocument();
    expect(w.getByTestId("finding-notes")).toHaveTextContent("DEMO trap catch");
    expect(w.queryByTestId("finding-map")).toBeNull();
    fireEvent.click(w.getByRole("button", { name: "View photo full size" }));
    const viewer = screen.getByTestId("finding-viewer");
    expect(within(viewer).getByRole("tab", { name: "Photo" })).toHaveAttribute("aria-selected", "true");
    expect(within(viewer).getByTestId("viewer-image").getAttribute("src")).toContain("&w=1600");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("finding-viewer")).toBeNull();
    expect(screen.getByTestId("finding-panel")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("finding-panel")).toBeNull();
  });

  it("View on map opens the viewer on the Location tab; the tabs switch", async () => {
    __setCropProfiles([
      { crop: "Avocado", label: "Avocado", slug: "avocado", station_type: "Block", block_grown: true, level_labels: [] },
    ]);
    fetchPhotoFeed.mockResolvedValueOnce(page([photo(1, { farm: "Lokitela", greenhouse: "Lokitela", block: "B3", tree: "12" })], false));
    render(<Gallery initialCrop="Avocado" />);
    await screen.findByTestId("gallery-masonry");
    fireEvent.click(screen.getByRole("button", { name: /Open photo: Thrips/ }));
    const panel = await screen.findByTestId("finding-panel");
    fireEvent.click(within(panel).getByRole("button", { name: /View on map/ }));
    const viewer = screen.getByTestId("finding-viewer");
    expect(within(viewer).getByRole("tab", { name: "Location" })).toHaveAttribute("aria-selected", "true");
    expect(await within(viewer).findByText("No block map for this finding yet")).toBeInTheDocument();
    expect(within(viewer).getByTestId("viewer-caption")).toHaveTextContent("Lokitela · Block B3 · Tree 12");
    expect(within(viewer).getByRole("link", { name: /Open in Heatmaps/ }).getAttribute("href")).toContain("#/avocado/heatmaps?gh=Lokitela&obs=Thrips&kind=pest");
    fireEvent.click(within(viewer).getByRole("tab", { name: "Photo" }));
    expect(within(viewer).getByTestId("viewer-image")).toBeInTheDocument();
  });

  it("closes the panel and viewer when the route changes", async () => {
    fetchPhotoFeed.mockResolvedValueOnce(page([photo(1)], false));
    render(<Gallery initialCrop="Rose" />);
    await screen.findByTestId("gallery-masonry");
    fireEvent.click(screen.getByRole("button", { name: /Open photo: Thrips/ }));
    const panel = await screen.findByTestId("finding-panel");
    fireEvent.click(within(panel).getByRole("button", { name: /View photo$/ }));
    expect(screen.getByTestId("finding-viewer")).toBeInTheDocument();
    act(() => {
      window.location.hash = "#/rose/scouting-map";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.queryByTestId("finding-viewer")).toBeNull();
    expect(screen.queryByTestId("finding-panel")).toBeNull();
  });

  it("shows the pop-up's empty state when there are no photos", async () => {
    fetchPhotoFeed.mockResolvedValueOnce(page([], false));
    render(<Gallery initialCrop="Rose" />);
    expect(await screen.findByText(/No photos yet/)).toBeInTheDocument();
  });

  it("formats capture stamps", () => {
    expect(formatCapture("2026-10-01 08:05:00")).toBe("1 Oct 2026 · 08:05");
    expect(formatCapture("2026-12-31")).toBe("31 Dec 2026");
    expect(formatCapture("")).toBe("");
  });
});
