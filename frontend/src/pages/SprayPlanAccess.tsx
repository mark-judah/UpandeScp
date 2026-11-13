/**
 * Spray Plan Access — General Manager-only admin page that assigns
 * Spray Plan Creators to farms. One row per Farm, inline-editable
 * multi-user chip picker with server-side typeahead.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert, RotateCcw, Check } from "lucide-react";
import { firstLoad, TableRowsSkeleton, TextSkeleton } from "@/components/Loading";
import { PageHeader } from "@/components/PageHeader";
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
  setFarmSupervisors,
  type FarmCreatorRow,
} from "@/lib/spray-plan-admin-api";
import { FrappeError } from "@/lib/frappe";

import { errorText } from "@/lib/errors";
interface RowState {
  farm: string;
  business_unit: string;
  saved: FarmCreatorRow[];
  draft: FarmCreatorRow[];
  sup_saved: FarmCreatorRow[];
  sup_draft: FarmCreatorRow[];
  saving: boolean;
  error: string | null;
}

function isDirty(r: RowState): boolean {
  return !rosterEqual(r.saved, r.draft) || !rosterEqual(r.sup_saved, r.sup_draft);
}

function rosterEqual(a: FarmCreatorRow[], b: FarmCreatorRow[]): boolean {
  if (a.length !== b.length) return false;
  const aUsers = a.map((x) => x.user).sort();
  const bUsers = b.map((x) => x.user).sort();
  return aUsers.every((u, i) => u === bUsers[i]);
}

export function SprayPlanAccess() {
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
            sup_saved: f.supervisors,
            sup_draft: f.supervisors,
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
          setError({ status: 0, message: errorText(e) });
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
    // Each roster is saved only if it changed, and one that saved stays saved
    // even when the other is refused, so the error shows against what is left.
    const patch: Partial<RowState> = {};
    try {
      if (!rosterEqual(row.saved, row.draft)) {
        const fresh = await setFarmCreators(farm, row.draft.map((d) => d.user));
        patch.saved = fresh.creators;
        patch.draft = fresh.creators;
        updateRow(farm, { saved: fresh.creators, draft: fresh.creators });
      }
      if (!rosterEqual(row.sup_saved, row.sup_draft)) {
        const fresh = await setFarmSupervisors(farm, row.sup_draft.map((d) => d.user));
        patch.sup_saved = fresh.supervisors;
        patch.sup_draft = fresh.supervisors;
      }
      updateRow(farm, { ...patch, saving: false });
    } catch (e) {
      updateRow(farm, { ...patch, saving: false, error: errorText(e) });
    }
  };

  const revertRow = (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, { draft: row.saved, sup_draft: row.sup_saved, error: null });
  };

  const dirtyCount = useMemo(
    () => (rows ?? []).filter((r) => isDirty(r)).length,
    [rows],
  );
  const totalCreators = useMemo(
    () => (rows ?? []).reduce((s, r) => s + r.saved.length, 0),
    [rows],
  );
  const totalSupervisors = useMemo(
    () => (rows ?? []).reduce((s, r) => s + r.sup_saved.length, 0),
    [rows],
  );

  const saveAll = async () => {
    const dirty = (rows ?? []).filter(isDirty);
    for (const r of dirty) await saveRow(r.farm);
  };

  return (
    <div className="flex flex-col min-h-svh">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Farm access
          </span>
        }
        eyebrow="Assign spray plan creators and spray supervisors to farms"
      >
        <div className="flex items-center gap-4">
          {rows ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {rows.length} farms · {totalCreators} creators · {totalSupervisors} supervisors
            </span>
          ) : loading ? (
            <TextSkeleton width="16ch" />
          ) : null}
          {dirtyCount > 0 && (
            <Button onClick={saveAll} size="sm" className="h-8">
              Save all ({dirtyCount})
            </Button>
          )}
        </div>
      </PageHeader>

      <section className="px-4 md:px-6 py-4">
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

        {!loading && !error && rows && rows.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No farms configured</CardTitle>
              <CardDescription>
                Create at least one Farm in Frappe Desk to start assigning
                spray plan creators and spray supervisors here.
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {(firstLoad(loading, !!rows) || (!loading && !error && rows && rows.length > 0)) && (
          <Card>
            <CardContent className="p-0" aria-busy={loading || undefined}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/5">Farm</TableHead>
                    <TableHead className="w-1/6">Business Unit</TableHead>
                    <TableHead>Spray plan creators</TableHead>
                    <TableHead>Spray supervisors</TableHead>
                    <TableHead className="w-40 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {!rows && <TableRowsSkeleton cols={5} rows={6} />}
                  {(rows || []).map((r) => {
                    const dirty = isDirty(r);
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
                        </TableCell>
                        <TableCell className="align-top">
                          <CreatorChipPicker
                            kind="supervisor"
                            value={r.sup_draft}
                            onChange={(next) => updateRow(r.farm, { sup_draft: next })}
                            disabled={r.saving}
                          />
                          <p className="text-[0.65rem] text-muted-foreground mt-1">
                            Can confirm the tank mix and scan, start and stop sprays on this farm; their phones download this farm&apos;s plans.
                          </p>
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
        )}
      </section>
    </div>
  );
}
