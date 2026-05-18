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
  | "spray-plan-access"
  | "application-plan";

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
  "spray-plan-access",
  "application-plan",
]);

function viewFromHash(): View {
  const raw = (window.location.hash || "").replace(/^#\/?/, "").toLowerCase();
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
