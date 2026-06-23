import { lazy, Suspense, useEffect, useState } from "react";
import { useRoute, cropDisplayName } from "@/lib/router";
import { AppSidebar } from "@/components/AppSidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { LoadingStrip } from "@/components/LoadingStrip";
import { primeBedsAndZones, primeMapSettings } from "@/lib/scouting-api";
import { loadObservationColors } from "@/lib/observation-colors";
import { bootstrap } from "@/lib/frappe";

const STORE_KEEPER_ROLE = "Store Keeper";

// Each page imports its own heavy deps (recharts, leaflet, react-day-picker).
// React.lazy + Suspense splits them into separate bundles so first paint of
// any single page never pulls every library at once.
const Dashboard = lazy(() =>
  import("@/pages/Dashboard").then((m) => ({ default: m.Dashboard })),
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

function PageFallback() {
  return <LoadingStrip active />;
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
  const cropName = cropDisplayName(crop);
  const isPoc = usePocHashMatch();

  // Warm long-lived reference caches once per session. Heatmaps and the
  // Application Plan diagnose plot read straight from the IDB-backed
  // bed/zone payload — priming on boot means switching to those pages
  // does not pay a network round-trip.
  useEffect(() => {
    primeBedsAndZones();
    primeMapSettings();
    void loadObservationColors();
  }, []);

  // Store Keepers land on Spray Plan Transfers (not the scouting
  // Dashboard they don't have access to anyway). Only redirect when
  // Store Keeper is the user's *exclusive* elevated role — a System
  // Manager who happens to also hold Store Keeper still lands on the
  // normal dashboard. Only redirect once, on the first mount when no
  // explicit hash was set.
  useEffect(() => {
    const roles = bootstrap().roles || [];
    const elevated = ["System Manager", "Administrator", "General Manager"];
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
        <Suspense
          fallback={
            view === "application-plan" ? (
              <ApplicationPlanSkeleton />
            ) : (
              <PageFallback />
            )
          }
        >
          {isPoc ? (
            <HeatmapPoc />
          ) : view === "trends" ? (
            <Trends initialCrop={cropName} />
          ) : view === "observations" ? (
            <Observations initialCrop={cropName} />
          ) : view === "traps" ? (
            <TrapsMap initialCrop={cropName} />
          ) : view === "heatmaps" ? (
            <Heatmaps initialCrop={cropName} />
          ) : view === "scouting-map" ? (
            <RoseScouting />
          ) : view === "spraying" ? (
            <Spraying />
          ) : view === "varieties" ? (
            <Varieties />
          ) : view === "reports" ? (
            <Reports />
          ) : view === "tank-mixes" ? (
            <TankMixes />
          ) : view === "historical" ? (
            <Historical />
          ) : view === "approvals" ? (
            <Approvals />
          ) : view === "settings" ? (
            <Settings />
          ) : view === "spray-plan-access" ? (
            <SprayPlanAccess />
          ) : view === "application-plan" ? (
            <ApplicationPlan />
          ) : view === "chemical-dashboard" ? (
            <ChemicalDashboard />
          ) : view === "spray-plan-transfers" ? (
            <SprayPlanTransfers />
          ) : view === "labels" ? (
            <Labels />
          ) : view === "creator-stock" ? (
            <CreatorStock />
          ) : view === "chemical-progress" ? (
            <ChemicalProgress />
          ) : view === "chemical-loaning" ? (
            <ChemicalLoaning />
          ) : (
            <Dashboard initialCrop={cropName} />
          )}
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  );
}
