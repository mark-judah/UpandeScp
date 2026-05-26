import { useEffect, useState, useCallback } from "react";

export type View =
  | "dashboard"
  | "trends"
  | "observations"
  | "traps"
  | "heatmaps"
  | "rose"
  | "avocado"
  | "varieties"
  | "reports"
  | "tank-mixes"
  | "historical"
  | "approvals"
  | "settings"
  | "spray-plan-access"
  | "application-plan"
  | "chemical-dashboard"
  | "spray-plan-transfers"
  | "labels"
  | "creator-stock";

const DEFAULT: View = "dashboard";
const KNOWN_VIEWS: ReadonlySet<View> = new Set([
  "dashboard",
  "trends",
  "observations",
  "traps",
  "heatmaps",
  "rose",
  "avocado",
  "varieties",
  "reports",
  "tank-mixes",
  "historical",
  "approvals",
  "settings",
  "spray-plan-access",
  "application-plan",
  "chemical-dashboard",
  "spray-plan-transfers",
  "labels",
  "creator-stock",
]);

function viewFromHash(): View {
  // Strip the optional ?tab=... suffix the Settings page uses so the
  // hash-based router still resolves the base view correctly.
  const rawWithQuery = (window.location.hash || "").replace(/^#\/?/, "").toLowerCase();
  const raw = rawWithQuery.split("?")[0];
  if ((KNOWN_VIEWS as Set<string>).has(raw)) return raw as View;
  return DEFAULT;
}

export function viewHash(view: View): string {
  return `#/${view}`;
}

export function useView(): [View, (next: View) => void] {
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next: View) => {
    if (window.location.hash !== viewHash(next)) {
      window.location.hash = viewHash(next);
    }
  }, []);

  return [view, navigate];
}
