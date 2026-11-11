import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CondensationAlerts, WindowWeatherChip, type WindowWeather } from "@/components/WeatherWindow";

const callMock = vi.fn();
vi.mock("@/lib/frappe", () => ({ call: (...a: unknown[]) => callMock(...a) }));

const ok: WindowWeather = {
  status: "ok", tempMin: 12, tempMax: 17, humidityMax: 91, precipProb: 60, precipMm: 1.2,
  windMax: 18, gustMax: 30, dewSpreadMin: 1.4,
  flags: [
    { kind: "rain", text: "Rain likely in the spray window" },
    { kind: "wind", text: "Windy in the spray window (drift risk)" },
  ],
};

describe("WindowWeatherChip", () => {
  it("shows the window figures and warn flags", () => {
    render(<WindowWeatherChip weather={ok} />);
    expect(screen.getByText(/12–17/)).toBeTruthy();
    expect(screen.getByText(/RH 91%/)).toBeTruthy();
    expect(screen.getByTestId("wx-flags").textContent).toContain("Rain likely");
    expect(screen.getByTestId("wx-flags").textContent).toContain("Windy");
  });

  it("says when the forecast is not available yet", () => {
    render(<WindowWeatherChip weather={{ status: "unavailable", reason: "beyond_horizon", message: "Forecast not available yet" }} />);
    expect(screen.getByTestId("wx-unavailable").textContent).toBe("Forecast not available yet");
  });

  it("shows the submit-time snapshot beside the live forecast", () => {
    render(<WindowWeatherChip weather={ok} snapshot={{ ...ok, tempMin: 10, tempMax: 14 }} />);
    expect(screen.getByTestId("wx-snapshot").textContent).toContain("At submit: 10–14");
  });

  it("renders no flags row when the window is calm", () => {
    render(<WindowWeatherChip weather={{ ...ok, flags: [] }} />);
    expect(screen.queryByTestId("wx-flags")).toBeNull();
  });
});

describe("CondensationAlerts", () => {
  beforeEach(() => callMock.mockReset());

  it("lists today's houses", async () => {
    callMock.mockResolvedValue([
      { name: "CA-1", greenhouse: "Karen GH 3 - KR", alert_date: "2026-11-12", hours: 2.5, min_spread: 1.1, max_humidity: 97 },
    ]);
    render(<CondensationAlerts farms={["Karen"]} />);
    await waitFor(() => expect(screen.getByTestId("condensation-alerts")).toBeTruthy());
    expect(screen.getByText(/Karen GH 3 · 2.5 h/)).toBeTruthy();
    expect(callMock.mock.calls[0][1]).toMatchObject({ farms: "Karen" });
  });

  it("renders nothing without alerts", async () => {
    callMock.mockResolvedValue([]);
    const { container } = render(<CondensationAlerts />);
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
