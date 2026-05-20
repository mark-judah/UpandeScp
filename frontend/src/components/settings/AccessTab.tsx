/**
 * Port of the standalone SprayPlanAccess page — assigns Spray Plan
 * Creators to farms via the same listFarmsWithCreators / setFarmCreators
 * endpoints. Now lives inside the unified Settings page.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldAlert, RotateCcw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { CreatorChipPicker } from "@/components/spray-plan-access/CreatorChipPicker";
import {
  listFarmsWithCreators,
  setFarmCreators,
  type FarmCreatorRow,
} from "@/lib/spray-plan-admin-api";
import { FrappeError } from "@/lib/frappe";

interface RowState {
  farm: string;
  business_unit: string;
  saved: FarmCreatorRow[];
  draft: FarmCreatorRow[];
  saving: boolean;
  error: string | null;
}

function rosterEqual(a: FarmCreatorRow[], b: FarmCreatorRow[]): boolean {
  if (a.length !== b.length) return false;
  const aUsers = a.map((x) => x.user).sort();
  const bUsers = b.map((x) => x.user).sort();
  return aUsers.every((u, i) => u === bUsers[i]);
}

export function AccessTab() {
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listFarmsWithCreators()
      .then((farms) => {
        if (cancelled) return;
        setRows(
          farms.map((f) => ({
            farm: f.farm,
            business_unit: f.business_unit,
            saved: f.creators,
            draft: f.creators,
            saving: false,
            error: null,
          })),
        );
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

  const updateRow = (farm: string, patch: Partial<RowState>) =>
    setRows((prev) =>
      prev ? prev.map((r) => (r.farm === farm ? { ...r, ...patch } : r)) : prev,
    );

  const saveRow = async (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, { saving: true, error: null });
    try {
      const fresh = await setFarmCreators(
        farm,
        row.draft.map((d) => d.user),
      );
      updateRow(farm, {
        saved: fresh.creators,
        draft: fresh.creators,
        saving: false,
      });
    } catch (e) {
      const msg = e instanceof FrappeError ? e.message : String(e);
      updateRow(farm, { saving: false, error: msg });
    }
  };

  const revertRow = (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, { draft: row.saved, error: null });
  };

  const dirtyCount = useMemo(
    () => (rows ?? []).filter((r) => !rosterEqual(r.saved, r.draft)).length,
    [rows],
  );

  const saveAll = async () => {
    const dirty = (rows ?? []).filter((r) => !rosterEqual(r.saved, r.draft));
    for (const r of dirty) await saveRow(r.farm);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center text-sm text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading farms…
        </CardContent>
      </Card>
    );
  }
  if (error?.status === 403) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <ShieldAlert className="h-4 w-4" />
            Access denied
          </CardTitle>
          <CardDescription>
            This page is restricted to General Manager and System Manager.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <ShieldAlert className="h-4 w-4" />
            Failed to load
          </CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (rows && rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">No farms configured</CardTitle>
          <CardDescription>
            Create at least one Farm in Frappe Desk to start assigning Spray
            Plan Creators here.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {dirtyCount > 0 && (
        <div className="flex justify-end">
          <Button onClick={saveAll} size="sm" className="h-8">
            Save all ({dirtyCount})
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/5">Farm</TableHead>
                <TableHead className="w-1/6">Business Unit</TableHead>
                <TableHead>Spray Plan Creators</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rows ?? []).map((r) => {
                const dirty = !rosterEqual(r.saved, r.draft);
                return (
                  <TableRow key={r.farm} className={dirty ? "bg-amber-50/30" : ""}>
                    <TableCell className="font-medium">{r.farm}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.business_unit || "—"}
                    </TableCell>
                    <TableCell>
                      <CreatorChipPicker
                        value={r.draft}
                        onChange={(next) => updateRow(r.farm, { draft: next })}
                        disabled={r.saving}
                      />
                      {r.error && (
                        <div className="text-[0.65rem] text-destructive mt-1 flex items-start gap-1">
                          <ShieldAlert className="h-3 w-3 mt-[1px] flex-shrink-0" />
                          <span>{r.error}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-1">
                        {dirty && !r.saving && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => revertRow(r.farm)}
                              title="Revert"
                            >
                              <RotateCcw className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              className="h-7"
                              onClick={() => saveRow(r.farm)}
                            >
                              <Check className="h-3 w-3" />
                              Save
                            </Button>
                          </>
                        )}
                        {r.saving && (
                          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        )}
                        {!dirty && !r.saving && (
                          <span className="text-[0.65rem] text-muted-foreground">
                            Saved
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
