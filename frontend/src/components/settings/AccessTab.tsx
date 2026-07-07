/**
 * Unified Spray Plan Access tab.
 *
 * One row per Farm with three parallel rosters plus two store mappings:
 *   • Spray Plan Creators — users who may draft plans for the farm.
 *   • Spray Plan Approvers — users who may approve those plans.
 *   • Store Keepers — users who may action store-side steps for the farm.
 *   • Chemical Store / Fertilizer Store — the warehouses that back the
 *     farm's chemical and fertilizer issues.
 *
 * Each chip picker / select dirty-tracks independently so saving one
 * column doesn't blow away unsaved edits in the others.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreatorChipPicker } from "@/components/spray-plan-access/CreatorChipPicker";
import {
  listFarmsWithCreators,
  listStoreWarehouseCandidates,
  setFarmApprovers,
  setFarmCreators,
  setFarmStoreKeepers,
  setFarmStores,
  type FarmApproverRow,
  type FarmCreatorRow,
  type FarmStoreKeeperRow,
  type StoreWarehouseCandidate,
} from "@/lib/spray-plan-admin-api";
import { FrappeError } from "@/lib/frappe";

/** Sentinel for "no warehouse selected" — Radix Select rejects an empty
 *  string as an item value, so we need a non-empty placeholder value. */
const NO_STORE = "__none__";

interface RowState {
  farm: string;
  business_unit: string;
  creators_saved: FarmCreatorRow[];
  creators_draft: FarmCreatorRow[];
  approvers_saved: FarmApproverRow[];
  approvers_draft: FarmApproverRow[];
  store_keepers_saved: FarmStoreKeeperRow[];
  store_keepers_draft: FarmStoreKeeperRow[];
  chemical_store_saved: string | null;
  chemical_store_draft: string | null;
  fertilizer_store_saved: string | null;
  fertilizer_store_draft: string | null;
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
  const [storeOptions, setStoreOptions] = useState<StoreWarehouseCandidate[]>(
    [],
  );

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
            creators_saved: f.creators,
            creators_draft: f.creators,
            approvers_saved: f.approvers,
            approvers_draft: f.approvers,
            store_keepers_saved: f.store_keepers,
            store_keepers_draft: f.store_keepers,
            chemical_store_saved: f.chemical_store,
            chemical_store_draft: f.chemical_store,
            fertilizer_store_saved: f.fertilizer_store,
            fertilizer_store_draft: f.fertilizer_store,
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

  useEffect(() => {
    let cancelled = false;
    listStoreWarehouseCandidates()
      .then((options) => {
        if (!cancelled) setStoreOptions(options);
      })
      .catch(() => {
        if (!cancelled) setStoreOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateRow = (farm: string, patch: Partial<RowState>) =>
    setRows((prev) =>
      prev ? prev.map((r) => (r.farm === farm ? { ...r, ...patch } : r)) : prev,
    );

  const isCreatorsDirty = (r: RowState) =>
    !rosterEqual(r.creators_saved, r.creators_draft);
  const isApproversDirty = (r: RowState) =>
    !rosterEqual(r.approvers_saved, r.approvers_draft);
  const isStoreKeepersDirty = (r: RowState) =>
    !rosterEqual(r.store_keepers_saved, r.store_keepers_draft);
  const isStoresDirty = (r: RowState) =>
    r.chemical_store_saved !== r.chemical_store_draft ||
    r.fertilizer_store_saved !== r.fertilizer_store_draft;
  const isDirty = (r: RowState) =>
    isCreatorsDirty(r) ||
    isApproversDirty(r) ||
    isStoreKeepersDirty(r) ||
    isStoresDirty(r);

  const saveRow = async (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, { saving: true, error: null });
    try {
      const patch: Partial<RowState> = { saving: false };
      if (isCreatorsDirty(row)) {
        const fresh = await setFarmCreators(
          farm,
          row.creators_draft.map((d) => d.user),
        );
        patch.creators_saved = fresh.creators;
        patch.creators_draft = fresh.creators;
      }
      if (isApproversDirty(row)) {
        const fresh = await setFarmApprovers(
          farm,
          row.approvers_draft.map((d) => d.user),
        );
        patch.approvers_saved = fresh.approvers;
        patch.approvers_draft = fresh.approvers;
      }
      if (isStoreKeepersDirty(row)) {
        const fresh = await setFarmStoreKeepers(
          farm,
          row.store_keepers_draft.map((d) => d.user),
        );
        patch.store_keepers_saved = fresh.store_keepers;
        patch.store_keepers_draft = fresh.store_keepers;
      }
      if (isStoresDirty(row)) {
        const fresh = await setFarmStores(
          farm,
          row.chemical_store_draft,
          row.fertilizer_store_draft,
        );
        patch.chemical_store_saved = fresh.chemical_store;
        patch.chemical_store_draft = fresh.chemical_store;
        patch.fertilizer_store_saved = fresh.fertilizer_store;
        patch.fertilizer_store_draft = fresh.fertilizer_store;
      }
      updateRow(farm, patch);
    } catch (e) {
      const msg = e instanceof FrappeError ? e.message : String(e);
      updateRow(farm, { saving: false, error: msg });
    }
  };

  const revertRow = (farm: string) => {
    const row = rows?.find((r) => r.farm === farm);
    if (!row) return;
    updateRow(farm, {
      creators_draft: row.creators_saved,
      approvers_draft: row.approvers_saved,
      store_keepers_draft: row.store_keepers_saved,
      chemical_store_draft: row.chemical_store_saved,
      fertilizer_store_draft: row.fertilizer_store_saved,
      error: null,
    });
  };

  const dirtyCount = useMemo(
    () => (rows ?? []).filter(isDirty).length,
    [rows],
  );

  const saveAll = async () => {
    const dirty = (rows ?? []).filter(isDirty);
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
            Plan Creators and Approvers here.
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
                <TableHead className="w-1/6">Farm</TableHead>
                <TableHead className="w-1/8">Business Unit</TableHead>
                <TableHead>Spray Plan Creators</TableHead>
                <TableHead>Spray Plan Approvers</TableHead>
                <TableHead>Store Keepers</TableHead>
                <TableHead className="w-40">Chemical Store</TableHead>
                <TableHead className="w-40">Fertilizer Store</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(rows ?? []).map((r) => {
                const dirty = isDirty(r);
                return (
                  <TableRow key={r.farm} className={dirty ? "bg-amber-50/30" : ""}>
                    <TableCell className="font-medium align-top">
                      {r.farm}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground align-top">
                      {r.business_unit || "—"}
                    </TableCell>
                    <TableCell className="align-top">
                      <CreatorChipPicker
                        kind="creator"
                        value={r.creators_draft}
                        onChange={(next) =>
                          updateRow(r.farm, { creators_draft: next })
                        }
                        disabled={r.saving}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <CreatorChipPicker
                        kind="approver"
                        value={r.approvers_draft}
                        onChange={(next) =>
                          updateRow(r.farm, { approvers_draft: next })
                        }
                        disabled={r.saving}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <CreatorChipPicker
                        kind="storekeeper"
                        value={r.store_keepers_draft}
                        onChange={(next) =>
                          updateRow(r.farm, { store_keepers_draft: next })
                        }
                        disabled={r.saving}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Select
                        value={r.chemical_store_draft ?? NO_STORE}
                        onValueChange={(v) =>
                          updateRow(r.farm, {
                            chemical_store_draft: v === NO_STORE ? null : v,
                          })
                        }
                        disabled={r.saving}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_STORE}>None</SelectItem>
                          {storeOptions.map((w) => (
                            <SelectItem key={w.name} value={w.name}>
                              {w.name}
                              {w.custom_farm ? ` (${w.custom_farm})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="align-top">
                      <Select
                        value={r.fertilizer_store_draft ?? NO_STORE}
                        onValueChange={(v) =>
                          updateRow(r.farm, {
                            fertilizer_store_draft: v === NO_STORE ? null : v,
                          })
                        }
                        disabled={r.saving}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_STORE}>None</SelectItem>
                          {storeOptions.map((w) => (
                            <SelectItem key={w.name} value={w.name}>
                              {w.name}
                              {w.custom_farm ? ` (${w.custom_farm})` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {r.error && (
                        <div className="text-[0.65rem] text-destructive mt-1 flex items-start gap-1">
                          <ShieldAlert className="h-3 w-3 mt-[1px] flex-shrink-0" />
                          <span>{r.error}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right align-top">
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
