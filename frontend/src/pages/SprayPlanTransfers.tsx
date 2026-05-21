import { Truck } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Spray Plan Transfers — Store-Keeper view for bulk-submitting
 * Material Transfer for Manufacture Stock Entries that come out of
 * the spray-plan approval flow, authorised by a single biometric scan
 * against the existing ``verify_employee`` server method. Placeholder
 * until the backend list endpoint + biometric-bulk-submit method land
 * in the next commit.
 */
export function SprayPlanTransfers() {
  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-center gap-2">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <div>
            <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
              Spray Plan Transfers
            </h1>
            <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
              Material Transfer for Manufacture · biometric-authorised bulk submit
            </p>
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 md:px-6 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4" />
              Coming together
            </CardTitle>
            <CardDescription>
              This view will list every Material Transfer for
              Manufacture Stock Entry currently in draft, scoped to
              the approved Application Floor Plans, and let you select
              one or more rows and submit them in bulk after a single
              biometric scan. The backend list method + bulk-submit
              flow are landing in the next commit; this stub confirms
              the route, sidebar entry and role gating work first.
            </CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </div>
    </div>
  );
}
