/**
 * Spray Plan Access — General Manager-only admin page that assigns
 * Spray Plan Creators to farms. One row per Farm, inline-editable
 * multi-user chip picker with server-side typeahead.
 *
 * Server-side role gating: the underlying whitelisted endpoints all call
 * _require_admin() which throws 403 unless the user holds General Manager
 * or System Manager. We surface that as an Access-Denied panel.
 */

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listFarmsWithCreators,
  type FarmWithCreators,
} from "@/lib/spray-plan-admin-api";
import { FrappeError } from "@/lib/frappe";

export function SprayPlanAccess() {
  const [farms, setFarms] = useState<FarmWithCreators[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFarmsWithCreators()
      .then((rows) => {
        if (cancelled) return;
        setFarms(rows);
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

  const totalCreators = (farms ?? []).reduce(
    (s, f) => s + (f.creators?.length || 0),
    0,
  );

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
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
          {farms && (
            <div className="text-xs text-muted-foreground tabular-nums">
              {farms.length} farms · {totalCreators} creators
            </div>
          )}
        </div>
      </header>

      <section className="px-4 md:px-6 py-4">
        {loading && (
          <Card>
            <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading farms…
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

        {!loading && !error && farms && farms.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No farms configured</CardTitle>
              <CardDescription>
                Create at least one Farm in Frappe Desk to start assigning
                Spray Plan Creators here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {!loading && !error && farms && farms.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/4">Farm</TableHead>
                    <TableHead className="w-1/6">Business Unit</TableHead>
                    <TableHead>Spray Plan Creators</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {farms.map((f) => (
                    <TableRow key={f.farm}>
                      <TableCell className="font-medium">{f.farm}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.business_unit || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {f.creators.length
                          ? f.creators.map((c) => c.full_name || c.user).join(" · ")
                          : "(none yet)"}
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        Task 3 wires this up
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
