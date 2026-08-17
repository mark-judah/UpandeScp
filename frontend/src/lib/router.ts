import { useEffect, useState, useCallback } from "react";

/**
 * Crop-namespaced hash router.
 *
 * The crop is the first path segment, the page is the second:
 *   #/rose/dashboard          rose · dashboard
 *   #/avocado/traps           avocado · traps
 *
 * The crop scopes everything downstream (sidebar + page data), so adding a
 * new scouted crop needs no new view ids — it reuses the same pages under a
 * new crop slug. Legacy single-segment links (#/dashboard) fall back to the
 * default crop so old bookmarks keep working.
 */

export type View =
  | "dashboard"
  | "trends"
  | "observations"
  | "traps"
  | "heatmaps"
  | "scouting-map"
  | "spraying"
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
  | "creator-stock"
  | "chemical-progress"
  | "chemical-loaning"
  | "procurement"
  | "notifications";

const KNOWN_VIEWS: ReadonlySet<View> = new Set<View>([
  "notifications",
  "procurement",
  "dashboard",
  "trends",
  "observations",
  "traps",
  "heatmaps",
  "scouting-map",
  "spraying",
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
  "chemical-progress",
  "chemical-loaning",
]);

export const DEFAULT_CROP_SLUG = "rose";
const DEFAULT_VIEW: View = "dashboard";

export type Route = { crop: string; view: View };

/** Display name -> URL slug: "Passion Fruit" -> "passion-fruit". */
export function cropSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** URL slug -> crop display name (what the page's crop filter expects):
 *  "rose" -> "Rose", "passion-fruit" -> "Passion Fruit". */
export function cropDisplayName(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function isKnownView(v: string): v is View {
  return (KNOWN_VIEWS as Set<string>).has(v);
}

function parseHash(): Route {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  const parts = raw.split("?")[0].split("/").filter(Boolean);

  if (parts.length >= 2) {
    const view = parts[1].toLowerCase();
    return {
      crop: cropSlug(parts[0]),
      view: isKnownView(view) ? view : DEFAULT_VIEW,
    };
  }
  if (parts.length === 1) {
    const only = parts[0].toLowerCase();
    // Legacy single-segment view (#/dashboard) keeps working on the default
    // crop; anything else is read as a bare crop landing on its default page.
    if (isKnownView(only)) return { crop: DEFAULT_CROP_SLUG, view: only };
    return { crop: cropSlug(only), view: DEFAULT_VIEW };
  }
  return { crop: DEFAULT_CROP_SLUG, view: DEFAULT_VIEW };
}

export function routeHash(route: Route): string {
  return `#/${route.crop}/${route.view}`;
}

export function useRoute(): [Route, (next: Partial<Route>) => void] {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // Read the live hash (not closed-over state) so a partial navigate always
  // merges onto the current route. The hashchange listener syncs state.
  const navigate = useCallback((next: Partial<Route>) => {
    const merged = { ...parseHash(), ...next };
    const h = routeHash(merged);
    if (window.location.hash !== h) window.location.hash = h;
  }, []);

  return [route, navigate];
}
