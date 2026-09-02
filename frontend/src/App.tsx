import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useRoute, cropDisplayName, type View } from "@/lib/router";
import { AppSidebar, canOpenView } from "@/components/AppSidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { ProgressBar } from "@/components/ProgressBar";
import { PerfClock } from "@/components/PerfClock";
import {
  primeBedsAndZones,
  primeMapSettings,
  primeAvocadoGeo,
} from "@/lib/scouting-api";
import { loadObservationColors } from "@/lib/observation-colors";
import { bootstrap } from "@/lib/frappe";

const STORE_KEEPER_ROLE = "SCP Chemical Store Keeper";

// Each page imports its own heavy deps (recharts, leaflet, react-day-picker).
// React.lazy + Suspense splits them into separate bundles so first paint of
// any single page never pulls every library at once.
const Dashboard = lazy(() =>
  import("@/pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const Notifications = lazy(() =>
  import("@/pages/Notifications").then((m) => ({ default: m.Notifications })),
);
const Trends = lazy(() =>
  import("@/pages/Trends").then((m) => ({ default: m.Trends })),
);
const Observations = lazy(() =>
  import("@/pages/Observations").then((m) => ({ default: m.Observations })),
);
const TrapsMap = lazy(() =>
  import("@/pages/TrapsMap").then((m) => ({ default: m.TrapsMap })),
);
const Heatmaps = lazy(() =>
  import("@/pages/Heatmaps").then((m) => ({ default: m.Heatmaps })),
);
const RoseScouting = lazy(() =>
  import("@/pages/RoseScouting").then((m) => ({ default: m.RoseScouting })),
);
const Spraying = lazy(() =>
  import("@/pages/Spraying").then((m) => ({ default: m.Spraying })),
);
const AvocadoScouting = lazy(() =>
  import("@/pages/avocado/AvocadoScouting").then((m) => ({
    default: m.AvocadoScouting,
  })),
);
const AvocadoObservations = lazy(() =>
  import("@/pages/avocado/AvocadoObservations").then((m) => ({
    default: m.AvocadoObservations,
  })),
);
const AvocadoTraps = lazy(() =>
  import("@/pages/avocado/AvocadoTraps").then((m) => ({
    default: m.AvocadoTraps,
  })),
);
const AvocadoHeatMap = lazy(() =>
  import("@/pages/avocado/AvocadoHeatMap").then((m) => ({
    default: m.AvocadoHeatMap,
  })),
);
const CoffeeTriadMap = lazy(() =>
  import("@/pages/coffee/CoffeeTriadMap").then((m) => ({
    default: m.CoffeeTriadMap,
  })),
);
const Varieties = lazy(() =>
  import("@/pages/Varieties").then((m) => ({ default: m.Varieties })),
);
const Reports = lazy(() =>
  import("@/pages/Reports").then((m) => ({ default: m.Reports })),
);
const TankMixes = lazy(() =>
  import("@/pages/TankMixes").then((m) => ({ default: m.TankMixes })),
);
const Historical = lazy(() =>
  import("@/pages/Historical").then((m) => ({ default: m.Historical })),
);
const Approvals = lazy(() =>
  import("@/pages/Approvals").then((m) => ({ default: m.Approvals })),
);
const SprayPlanAccess = lazy(() =>
  import("@/pages/SprayPlanAccess").then((m) => ({ default: m.SprayPlanAccess })),
);
const Settings = lazy(() =>
  import("@/pages/Settings").then((m) => ({ default: m.Settings })),
);
const ApplicationPlan = lazy(() =>
  import("@/pages/ApplicationPlan").then((m) => ({ default: m.ApplicationPlan })),
);
const ChemicalDashboard = lazy(() =>
  import("@/pages/ChemicalDashboard").then((m) => ({
    default: m.ChemicalDashboard,
  })),
);
const SprayPlanTransfers = lazy(() =>
  import("@/pages/SprayPlanTransfers").then((m) => ({
    default: m.SprayPlanTransfers,
  })),
);
const Labels = lazy(() =>
  import("@/pages/Labels").then((m) => ({ default: m.Labels })),
);
const CreatorStock = lazy(() =>
  import("@/pages/CreatorStock").then((m) => ({ default: m.CreatorStock })),
);
const ChemicalProgress = lazy(() =>
  import("@/pages/ChemicalProgress").then((m) => ({
    default: m.ChemicalProgress,
  })),
);
const Procurement = lazy(() =>
  import("@/pages/Procurement").then((m) => ({ default: m.Procurement })),
);
const Postponements = lazy(() =>
  import("@/pages/Postponements").then((m) => ({ default: m.Postponements })),
);
const ChemicalLoaning = lazy(() =>
  import("@/pages/ChemicalLoaning").then((m) => ({
    default: m.ChemicalLoaning,
  })),
);
// Throwaway POC route — gated on a hash that the normal router doesn't
// recognise so it never appears in the sidebar. Open with
// ``#/poc-heatmap?gh=<Greenhouse>&obs=<Name>&kind=pest|disease``.
const HeatmapPoc = lazy(() =>
  import("@/pages/HeatmapPoc").then((m) => ({ default: m.HeatmapPoc })),
);

// Route chunks to warm after first paint. Prefetching them means navigating
// never shows the Suspense chunk loader — you land on the page and only its
// data loads. Vite dedupes these to the same chunks as the lazy() imports.
const PREFETCH: Array<() => Promise<unknown>> = [
  () => import("@/pages/Dashboard"),
  () => import("@/pages/Trends"),
  () => import("@/pages/Observations"),
  () => import("@/pages/TrapsMap"),
  () => import("@/pages/Heatmaps"),
  () => import("@/pages/RoseScouting"),
  () => import("@/pages/avocado/AvocadoScouting"),
  () => import("@/pages/avocado/AvocadoObservations"),
  () => import("@/pages/avocado/AvocadoTraps"),
  () => import("@/pages/avocado/AvocadoHeatMap"),
  () => import("@/pages/coffee/CoffeeTriadMap"),
  () => import("@/pages/Spraying"),
  () => import("@/pages/Varieties"),
  () => import("@/pages/Reports"),
  () => import("@/pages/TankMixes"),
  () => import("@/pages/Historical"),
  () => import("@/pages/Approvals"),
  () => import("@/pages/SprayPlanAccess"),
  () => import("@/pages/Settings"),
  () => import("@/pages/ApplicationPlan"),
  () => import("@/pages/ChemicalDashboard"),
  () => import("@/pages/SprayPlanTransfers"),
  () => import("@/pages/Labels"),
  () => import("@/pages/CreatorStock"),
  () => import("@/pages/ChemicalProgress"),
  () => import("@/pages/ChemicalLoaning"),
  () => import("@/pages/Procurement"),
  () => import("@/pages/Postponements"),
];

/**
 * Keep-alive wrapper: a visited section mounts once and stays mounted, hidden
 * with ``display:none`` when inactive instead of being unmounted. Revisiting is
 * instant and only the page's data refetches — the maps' ResizeObservers
 * (Map3D / MapBase) refire when the container is re-shown, so they repaint at
 * the right size. ``display:contents`` when active keeps the page a layout-
 * transparent child of SidebarInset (identical layout to rendering it directly).
 */
function KeepAlive({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <div style={{ display: active ? "contents" : "none" }}>{children}</div>;
}

/** The page component for a given crop + view. Crop is fixed per keep-alive
 *  entry, so ``initialCrop`` is stable for the life of the mounted page. */
/** Shown instead of a page the user's roles don't permit. */
function NotPermitted({ view }: { view: View }) {
  return (
    <div className="p-8 max-w-lg">
      <h2 className="text-base font-semibold">You don't have access to this page</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Your roles don't include access to <span className="font-mono">{view}</span>.
        If you think this is wrong, ask the SCP General Manager to review your
        roles under Settings → Access.
      </p>
    </div>
  );
}

function renderView(crop: string, view: View): ReactNode {
  const cropName = cropDisplayName(crop);

  // Gate the ROUTE, not just the sidebar link. Hiding a link is presentation,
  // not access control — `#/rose/approvals` typed into the address bar rendered
  // the Approvals page for anyone, and only looked empty because the server
  // refused the data. `canOpenView` reads the same nav definition the sidebar
  // does, so the two cannot drift apart.
  if (!canOpenView(view, crop, bootstrap().roles || [])) {
    return <NotPermitted view={view} />;
  }

  switch (view) {
    case "trends":
      return <Trends initialCrop={cropName} />;
    case "observations":
      return crop === "rose" ? (
        <Observations initialCrop={cropName} />
      ) : (
        <AvocadoObservations />
      );
    case "traps":
      return crop === "rose" ? (
        <TrapsMap initialCrop={cropName} />
      ) : (
        <AvocadoTraps />
      );
    case "heatmaps":
      return crop === "rose" ? (
        <Heatmaps initialCrop={cropName} />
      ) : (
        <AvocadoHeatMap />
      );
    case "scouting-map":
      return crop === "rose" ? (
        <RoseScouting />
      ) : crop === "coffee" ? (
        <CoffeeTriadMap />
      ) : (
        <AvocadoScouting />
      );
    case "spraying":
      return <Spraying />;
    case "varieties":
      return <Varieties />;
    case "reports":
      // Block-grown crops get the plain weekly block sheet; roses keep the KEPHIS
      // workbook and the daily/trap reports, which are rose-specific.
      return <Reports initialCrop={cropName} />;
    case "tank-mixes":
      return <TankMixes />;
    case "historical":
      return <Historical />;
    case "approvals":
      return <Approvals />;
    case "settings":
      return <Settings />;
    case "spray-plan-access":
      return <SprayPlanAccess />;
    case "application-plan":
      return <ApplicationPlan />;
    case "chemical-dashboard":
      return <ChemicalDashboard />;
    case "spray-plan-transfers":
      return <SprayPlanTransfers />;
    case "labels":
      return <Labels />;
    case "creator-stock":
      return <CreatorStock />;
    case "chemical-progress":
      return <ChemicalProgress />;
    case "chemical-loaning":
      return <ChemicalLoaning />;
    case "procurement":
      return <Procurement />;
    case "postponements":
      return <Postponements />;
    // Not crop-scoped: reached from the header bell, not a crop sidebar.
    case "notifications":
      return <Notifications />;
    default:
      return <Dashboard initialCrop={cropName} />;
  }
}

function PageFallback() {
  // A lazy chunk fetch reports no fraction, so the bar sweeps rather than showing
  // a percentage nothing measured.
  return (
    <div className="flex min-h-svh items-center justify-center">
      <div className="w-[min(22rem,80vw)]">
        <ProgressBar percent={null} label="Loading" />
      </div>
    </div>
  );
}

/* Page-shaped skeleton for ApplicationPlan. Matches the real header + two-column
 * layout so the user sees structure instantly while the heavy chunk (recharts,
 * leaflet, the 1500-line module) parses. */
function ApplicationPlanSkeleton() {
  return (
    <div className="flex flex-col min-h-svh animate-pulse">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 rounded bg-muted" />
            <div className="space-y-1.5">
              <div className="h-4 w-56 rounded bg-muted" />
              <div className="h-2.5 w-40 rounded bg-muted/70" />
            </div>
          </div>
          <div className="h-3 w-24 rounded bg-muted/70" />
        </div>
      </header>
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 p-4 md:p-6">
        <div className="lg:col-span-1 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="rounded-md border bg-card p-3 space-y-2">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="h-8 w-full rounded bg-muted/70" />
            </div>
          ))}
        </div>
        <div className="lg:col-span-2 rounded-md border bg-card p-4">
          <div className="h-4 w-40 rounded bg-muted mb-3" />
          <div className="h-72 w-full rounded bg-muted/60" />
        </div>
      </div>
    </div>
  );
}

function usePocHashMatch(): boolean {
  const [match, setMatch] = useState(() =>
    (window.location.hash || "").startsWith("#/poc-heatmap"),
  );
  useEffect(() => {
    const onHash = () =>
      setMatch((window.location.hash || "").startsWith("#/poc-heatmap"));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return match;
}

export function App() {
  const [{ crop, view }, navigate] = useRoute();
  const isPoc = usePocHashMatch();

  // Sections mount once and stay mounted (keep-alive), so revisiting is instant
  // and only data reloads. Track which crop/view pairs have been opened.
  const activeKey = `${crop}/${view}`;
  const [mountedKeys, setMountedKeys] = useState<string[]>([activeKey]);
  useEffect(() => {
    setMountedKeys((keys) =>
      keys.includes(activeKey) ? keys : [...keys, activeKey],
    );
  }, [activeKey]);

  // Prefetch route chunks on idle so the Suspense chunk loader never shows on
  // navigation (see PREFETCH above).
  useEffect(() => {
    let i = 0;
    const ric: (fn: () => void) => void =
      (window as unknown as { requestIdleCallback?: (fn: () => void) => void })
        .requestIdleCallback || ((fn) => window.setTimeout(fn, 200));
    const pump = () => {
      if (i >= PREFETCH.length) return;
      void PREFETCH[i++]().catch(() => {});
      ric(pump);
    };
    ric(pump);
  }, []);

  // Warm long-lived reference caches once per session. Heatmaps and the
  // Application Plan diagnose plot read straight from the IDB-backed
  // bed/zone payload — priming on boot means switching to those pages
  // does not pay a network round-trip.
  useEffect(() => {
    primeBedsAndZones();
    primeMapSettings();
    void loadObservationColors();
  }, []);

  // Warm the avocado 3D-map geometry as soon as the user is in the avocado
  // section, so the map's own fetch finds it cached (or shares the in-flight
  // request) instead of a cold round-trip on open.
  useEffect(() => {
    if (crop === "avocado") primeAvocadoGeo();
  }, [crop]);

  // Store Keepers land on Spray Plan Transfers (not the scouting
  // Dashboard they don't have access to anyway). Only redirect when
  // Store Keeper is the user's *exclusive* elevated role — a System
  // Manager who happens to also hold Store Keeper still lands on the
  // normal dashboard. Only redirect once, on the first mount when no
  // explicit hash was set.
  useEffect(() => {
    const roles = bootstrap().roles || [];
    const elevated = ["System Manager", "Administrator", "SCP General Manager"];
    const exclusive =
      roles.includes(STORE_KEEPER_ROLE) &&
      !elevated.some((r) => roles.includes(r));
    if (!exclusive) return;
    const hash = window.location.hash || "";
    if (
      !hash ||
      hash === "#" ||
      hash === "#/" ||
      hash === "#/dashboard" ||
      hash === "#/rose/dashboard"
    ) {
      navigate({ view: "spray-plan-transfers" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar
        crop={crop}
        view={view}
        onNavigate={(v) => navigate({ view: v })}
      />
      <SidebarInset>
        {isPoc ? (
          <Suspense fallback={<PageFallback />}>
            <HeatmapPoc />
          </Suspense>
        ) : (
          mountedKeys.map((k) => {
            const sep = k.indexOf("/");
            const kCrop = k.slice(0, sep);
            const kView = k.slice(sep + 1) as View;
            const active = k === activeKey;
            const fallback =
              kView === "application-plan" ? (
                <ApplicationPlanSkeleton />
              ) : (
                <PageFallback />
              );
            return (
              <KeepAlive key={k} active={active}>
                <Suspense fallback={active ? fallback : null}>
                  {renderView(kCrop, kView)}
                </Suspense>
              </KeepAlive>
            );
          })
        )}
      </SidebarInset>
      <PerfClock />
    </SidebarProvider>
  );
}
