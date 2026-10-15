import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActiveIngredients, formatAmount } from "@/components/spray-plan/ActiveIngredients";
import type { MixIngredient } from "@/lib/spray-compliance-api";

const ing = (over: Partial<MixIngredient> = {}): MixIngredient => ({
  name: "Abamectin", codes: ["IRAC 6"], concentration: 18, concentration_unit: "g/L", concentration_label: "18 g/L",
  status: "ok", amount: 54, amount_unit: "g", per_ha: 108, ...over,
});

describe("formatAmount", () => {
  it("scales grams and writes counts in scientific notation", () => {
    expect(formatAmount(54, "g")).toBe("54 g");
    expect(formatAmount(1500, "g")).toBe("1.5 kg");
    expect(formatAmount(0.25, "g")).toBe("250 mg");
    expect(formatAmount(2e12, "CFU")).toBe("2.00 x 10^12 CFU");
    expect(formatAmount(null, "g")).toBe("");
  });
});

describe("ActiveIngredients", () => {
  it("shows name, MoA group, concentration, the amount used and per hectare", () => {
    render(<ActiveIngredients items={[ing()]} />);
    const t = screen.getByTestId("active-ingredient");
    expect(t.className).toContain("bg-primary/10");
    expect(t.textContent).toContain("Abamectin");
    expect(t.textContent).toContain("IRAC 6");
    expect(t.textContent).toContain("18 g/L");
    expect(t.textContent).toContain("Uses 54 g");
    expect(t.textContent).toContain("108 g / ha");
  });

  it("omits per hectare when the area is unknown", () => {
    render(<ActiveIngredients items={[ing({ per_ha: null })]} />);
    expect(screen.getByTestId("active-ingredient").textContent).not.toContain("/ ha");
  });

  it("says the concentration is not recorded instead of guessing", () => {
    render(
      <ActiveIngredients
        items={[ing({ concentration: null, concentration_unit: null, concentration_label: null, status: "no_concentration", amount: null, amount_unit: null, per_ha: null })]}
      />,
    );
    const t = screen.getByTestId("active-ingredient");
    expect(t.textContent).toContain("concentration not recorded");
    expect(t.textContent).not.toContain("Uses");
  });

  it("renders nothing for a product with no ingredients", () => {
    const { container } = render(<ActiveIngredients items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
