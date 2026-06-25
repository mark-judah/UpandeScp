/**
 * Unified Spray Plan Settings page.
 *
 * Four tabs gated to GM / System Manager:
 *   • Access            — assign Spray Plan Creators to farms (legacy).
 *   • Spray Plan        — Spray Plan Settings (Single doctype) form.
 *   • Farms & Map       — Map Settings + per-farm coordinates.
 *   • Chemicals         — Item rows in the chemical groups with full
 *                         per-item edit drawer (rate, codes, targets).
 *
 * The active tab persists via the URL hash (?tab=spray-plan), so a deep
 * link or browser back keeps the operator on the same section.
 */

import { useEffect, useState } from "react";
import {
  Beaker,
  Gauge,
  ListOrdered,
  Loader2,
  MapPin,
  Settings as SettingsIcon,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Workflow,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccessTab } from "@/components/settings/AccessTab";
import { ChemicalsTab } from "@/components/settings/ChemicalsTab";
import { FarmMapTab } from "@/components/settings/FarmMapTab";
import { SprayPlanTab } from "@/components/settings/SprayPlanTab";
import { ProcessesTab } from "@/components/settings/ProcessesTab";
import { ThresholdsTab } from "@/components/settings/ThresholdsTab";
import { OrderingTab } from "@/components/settings/OrderingTab";
import { FrappeError } from "@/lib/frappe";
import {
  fetchSettingsBundle,
  type SettingsBundle,
} from "@/lib/settings-api";

const TABS = ["access", "spray-plan", "processes", "thresholds", "ordering", "farms", "chemicals"] as const;
type TabId = (typeof TABS)[number];

function getInitialTab(): TabId {
  const m = (window.location.hash || "").match(/[?&]tab=([a-z-]+)/i);
  const want = (m?.[1] || "").toLowerCase() as TabId;
  return (TABS as readonly string[]).includes(want) ? want : "access";
}

function pushTabHash(tab: TabId) {
  const base = window.location.hash.split("?")[0] || "#/settings";
  window.location.hash = `${base}?tab=${tab}`;
}

export function Settings() {
  const [tab, setTab] = useState<TabId>(getInitialTab);
  const [bundle, setBundle] = useState<SettingsBundle | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSettingsBundle()
      .then((b) => {
        if (!cancelled) setBundle(b);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof FrappeError) {
          setError({ status: e.status, message: e.message });
        } else {
          setError({ status: 0, message: String(e) });
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the URL hash in sync when the tab changes.
  const handleTab = (next: string) => {
    if (!(TABS as readonly string[]).includes(next)) return;
    setTab(next as TabId);
    pushTabHash(next as TabId);
  };

  // Listen for external hash changes (back/forward, deep link).
  useEffect(() => {
    const onChange = () => setTab(getInitialTab());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
                <SettingsIcon className="h-4 w-4" />
                Spray Plan Settings
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Access · Plan rules · Maps · Chemicals
              </p>
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 md:px-6 py-4">
        {loading && (
          <Card>
            <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading settings…
            </CardContent>
          </Card>
        )}

        {!loading && error?.status === 403 && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Access denied
              </CardTitle>
              <CardDescription>
                This page is restricted to General Manager and System Manager.
                Ask an administrator if you believe this is incorrect.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && error && error.status !== 403 && (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Failed to load
              </CardTitle>
              <CardDescription>{error.message}</CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && !error && bundle && (
          <Tabs value={tab} onValueChange={handleTab} className="w-full">
            <TabsList>
              <TabsTrigger value="access">
                <ShieldCheck />
                Access
              </TabsTrigger>
              <TabsTrigger value="spray-plan">
                <Sliders />
                Spray Plan
              </TabsTrigger>
              <TabsTrigger value="processes">
                <Workflow />
                Processes
              </TabsTrigger>
              <TabsTrigger value="thresholds">
                <Gauge />
                Thresholds
              </TabsTrigger>
              <TabsTrigger value="ordering">
                <ListOrdered />
                Ordering
              </TabsTrigger>
              <TabsTrigger value="farms">
                <MapPin />
                Farms & Map
              </TabsTrigger>
              <TabsTrigger value="chemicals">
                <Beaker />
                Chemicals
              </TabsTrigger>
            </TabsList>

            <TabsContent value="access">
              <AccessTab />
            </TabsContent>
            <TabsContent value="spray-plan">
              <SprayPlanTab
                initial={bundle.spray_plan}
                farms={bundle.farms}
                onSaved={(saved) =>
                  setBundle({ ...bundle, spray_plan: saved })
                }
              />
            </TabsContent>
            <TabsContent value="processes">
              <ProcessesTab
                initial={bundle.spray_plan}
                onSaved={(saved) =>
                  setBundle({ ...bundle, spray_plan: saved })
                }
              />
            </TabsContent>
            <TabsContent value="thresholds">
              <ThresholdsTab />
            </TabsContent>
            <TabsContent value="ordering">
              <OrderingTab />
            </TabsContent>
            <TabsContent value="farms">
              <FarmMapTab
                initial={bundle.map_settings}
                farms={bundle.farms}
                onSaved={(saved) =>
                  setBundle({ ...bundle, map_settings: saved })
                }
              />
            </TabsContent>
            <TabsContent value="chemicals">
              <ChemicalsTab />
            </TabsContent>
          </Tabs>
        )}
      </section>
    </div>
  );
}
