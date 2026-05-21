import { Beaker } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Chemical Dashboard — Store-Keeper view of every chemical's stock
 * across all warehouses. Placeholder until the backend aggregator
 * lands; the next commit wires up Bin / Item / Warehouse queries and
 * adds the bar chart + per-warehouse table.
 */
export function ChemicalDashboard() {
  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <div>
            <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
              Chemical Dashboard
            </h1>
            <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              In-stock chemicals across all warehouses
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 md:px-6 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Beaker className="h-4 w-4" />
              Coming together
            </CardTitle>
            <CardDescription>
              This view lists every chemical currently in stock per
              warehouse and surfaces the totals as a bar chart. The
              aggregator endpoint and chart land in the next commit;
              this stub confirms the route, sidebar entry, and role
              gating work first.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </div>
    </div>
  );
}
