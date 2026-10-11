/**
 * Trap map motion (spec 2026-10-11 TM2, TM3): counted traps pulse, zero-count
 * traps stay still, reduced motion draws no ring, and a click zooms to the
 * trap and opens the recorder card.
 */
import { useEffect, useRef } from "react";
import L from "leaflet";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoutingEntry } from "@/lib/scouting-types";

const entries = [
  {
    name: "SE-1", date_of_capture: "2026-10-08", time_of_capture: "09:10:00", scouts_name: "100961",
    greenhouse: "GH1 - KR", zone: "Z1", latitude: -1.3, longitude: 36.7,
    trap_scouting_entry: [{ trap: "KR - T1", pest: "Thrips", location: "Indoor", count: 12 }],
  },
  {
    name: "SE-2", date_of_capture: "2026-10-09", time_of_capture: "14:35:10", scouts_name: "100962",
    greenhouse: "GH1 - KR", zone: "Z1", latitude: -1.3, longitude: 36.7,
    trap_scouting_entry: [{ trap: "KR - T1", pest: "Thrips", location: "Indoor", count: 7 }],
  },
  {
    name: "SE-3", date_of_capture: "2026-10-09", time_of_capture: "10:00:00", scouts_name: "100961",
    greenhouse: "GH1 - KR", zone: "Z2", latitude: -1.31, longitude: 36.71,
    trap_scouting_entry: [{ trap: "KR - T2", pest: "Thrips", location: "Indoor", count: 0 }],
  },
] as unknown as ScoutingEntry[];

const fetchLatestTrapReading = vi.fn();
vi.mock("@/lib/trap-reading-api", () => ({
  fetchLatestTrapReading: (...a: unknown[]) => fetchLatestTrapReading(...a),
}));
// Stable across renders, as the real hook's payload is.
const scouting = { data: { entries }, loading: false, progress: null, weeksLoaded: 1, weeksTotal: 1 };
const mapSettings = { lat: 0, lon: 0 };
vi.mock("@/hooks/use-scouting", () => ({ useScouting: () => scouting }));
vi.mock("@/lib/scouting-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/scouting-api")>()),
  fetchTrapLocations: () => Promise.resolve({}),
  fetchFarmsAndWarehouses: () => Promise.resolve({ Chepsito: ["GH1 - KR"] }),
}));
vi.mock("@/hooks/use-map-settings", () => ({
  useMapSettings: () => mapSettings,
  flyToFarm: () => {},
}));
vi.mock("@/lib/observation-colors", () => ({
  pestColor: () => "#999",
  readableInk: () => "#000",
  useObservationColors: () => ({ pest: () => "#999" }),
}));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: () => null }));
vi.mock("@/pages/maps/RangeHeader", () => ({
  ALL: "__all__",
  RangeHeader: () => <div>header</div>,
}));
// A real Leaflet map on a plain div — no tiles.
vi.mock("@/components/MapBase", () => ({
  MapBase: ({ onReady }: { onReady: (m: L.Map) => void }) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const m = L.map(ref.current!, { zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false })
        .setView([-1.3, 36.7], 15);
      onReady(m);
      return () => {
        m.remove();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div ref={ref} style={{ width: 800, height: 600 }} />;
  },
}));

const { TrapsMap } = await import("@/pages/TrapsMap");
const { trapPulse } = await import("@/lib/trap-pulse");

function setReducedMotion(on: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: on && q.includes("reduce"),
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
}

const original = window.matchMedia;
beforeEach(() => {
  fetchLatestTrapReading.mockReset();
  fetchLatestTrapReading.mockResolvedValue({
    trap: "KR - T1", entry: "SE-2", scout: "100962", scoutName: "IMELDA WANZA MUTUA",
    image: "/private/files/100962.jpg", date: "2026-10-09", time: "14:35:10", count: 7, pest: "Thrips",
    house: "GH1 - KR",
  });
});
afterEach(() => {
  window.matchMedia = original;
});

async function renderMap() {
  const r = render(<TrapsMap initialCrop="Rose" />);
  // markers are drawn after the map exists and the trap locations resolve
  await waitFor(() => expect(r.container.querySelectorAll(".scp-trap").length).toBe(2));
  return r;
}

describe("trap map motion", () => {
  it("counted traps pulse, sized by count; zero-count traps are static", async () => {
    setReducedMotion(false);
    const { container } = await renderMap();
    const traps = Array.from(container.querySelectorAll<HTMLElement>(".scp-trap"));
    const withRing = traps.filter((t) => t.querySelector(".scp-trap-ring"));
    expect(withRing).toHaveLength(1);
    expect(withRing[0].style.width).toBe(`${trapPulse(19).size}px`); // 12 + 7 catches
    const still = traps.find((t) => !t.querySelector(".scp-trap-ring"))!;
    expect(still.style.width).toBe("8px");
  });

  it("draws no pulse ring under prefers-reduced-motion", async () => {
    setReducedMotion(true);
    const { container } = await renderMap();
    expect(container.querySelectorAll(".scp-trap-ring")).toHaveLength(0);
  });

  it("a click zooms to the trap, then shows the recorder's photo, name and time", async () => {
    setReducedMotion(true); // jump, so the card shows without waiting for a fly
    const { container } = await renderMap();
    const ring = container.querySelectorAll<HTMLElement>(".scp-trap-marker");
    const target = Array.from(ring).find((el) => el.getAttribute("title")?.startsWith("KR - T1"))!;
    await act(async () => {
      fireEvent.click(target);
    });
    const card = await screen.findByTestId("trap-reading-card");
    await waitFor(() => expect(screen.getByTestId("trap-card-scout")).toHaveTextContent("IMELDA WANZA MUTUA"));
    expect(card.querySelector('img[src="/private/files/100962.jpg"]')).not.toBeNull();
    expect(screen.getByTestId("trap-card-time")).toHaveTextContent("9 Oct 2026 · 14:35");
    expect(screen.getByTestId("trap-card-count")).toHaveTextContent("7");
    expect(fetchLatestTrapReading.mock.calls[0][0]).toBe("KR - T1");
    // the selected trap is ringed (re-queried: a redraw replaces the elements)
    const selected = container.querySelectorAll<HTMLElement>(".scp-trap-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("title")).toMatch(/^KR - T1/);
    fireEvent.click(screen.getByRole("button", { name: "Close trap card" }));
    expect(screen.queryByTestId("trap-reading-card")).toBeNull();
  });
});
