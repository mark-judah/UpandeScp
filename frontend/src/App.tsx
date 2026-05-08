import { lazy, Suspense } from "react";
import { useView } from "@/lib/router";
import { AppSidebar } from "@/components/AppSidebar";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { LoadingStrip } from "@/components/LoadingStrip";

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
const AvocadoMap = lazy(() =>
  import("@/pages/AvocadoMap").then((m) => ({ default: m.AvocadoMap })),
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
const ApplicationPlan = lazy(() =>
  import("@/pages/ApplicationPlan").then((m) => ({ default: m.ApplicationPlan })),
);

function PageFallback() {
  return <LoadingStrip active />;
}

export function App() {
  const [view, navigate] = useView();
  return (
    <SidebarProvider>
      <AppSidebar view={view} onNavigate={navigate} />
      <SidebarInset>
        <Suspense fallback={<PageFallback />}>
          {view === "trends" ? (
            <Trends />
          ) : view === "observations" ? (
            <Observations />
          ) : view === "traps" ? (
            <TrapsMap />
          ) : view === "heatmaps" ? (
            <Heatmaps />
          ) : view === "rose" ? (
            <RoseScouting />
          ) : view === "avocado" ? (
            <AvocadoMap />
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
          ) : view === "application-plan" ? (
            <ApplicationPlan />
          ) : (
            <Dashboard />
          )}
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  );
}
