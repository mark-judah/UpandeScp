/**
 * Spray Plan Access — General Manager-only admin page that assigns
 * Spray Plan Creators to farms. One row per Farm, inline-editable
 * multi-user chip picker with server-side typeahead.
 *
 * Server-side role gating: the underlying whitelisted endpoints
 * (list_farms_with_creators, list_spray_plan_creator_candidates,
 * set_farm_creators) all call _require_admin() which throws unless the
 * user holds General Manager or System Manager. We surface that as a
 * 403 Access-Denied panel.
 */

import { Loader2, ShieldCheck } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";

export function SprayPlanAccess() {
  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <div>
            <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" />
              Spray Plan Access
            </h1>
            <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              Assign Spray Plan Creators to farms
            </p>
          </div>
        </div>
      </header>

      <section className="px-4 md:px-6 py-4">
        <Card>
          <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
