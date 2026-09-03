/**
 * Postponed sprays — the supervisor declares, the approver decides.
 *
 * Two jobs on one page because they are two ends of the same request. What the page
 * has to make visible, rather than merely obey:
 *
 * * **the deadline, before anybody misses it.** Every plan shows how long it can still
 *   be moved. A supervisor finding out at 10:01 that the option is gone is the failure
 *   this is meant to prevent.
 * * **past cutoff is not one state but two.** A plan can be past its cutoff — the
 *   spray is off — and still inside the grace window, where the slip can be recorded
 *   properly instead of the plan being left to rot until auto-cancel stops it.
 * * **refused requests stay on the record.** Why a plan happened when it did is as
 *   much about the slips that were refused as the ones that were granted.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  RefreshCw,
  Undo2,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { HeaderIconButton } from "@/components/header-controls";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toaster, type ToastItem } from "@/components/Toaster";
import { cn } from "@/lib/utils";
import { bootstrap, FrappeError } from "@/lib/frappe";
import { errorText } from "@/lib/errors";
import {
  declarePostponement,
  decidePostponement,
  describeDeadline,
  fetchPostponablePlans,
  fetchPostponementSettings,
  latestAllowed,
  listPostponements,
  shortTime,
  summarisePostponement,
  withdrawPostponement,
  type Postponement,
  type PostponablePlan,
  type PostponementSettings,
} from "@/lib/postponement-api";

const APPROVER_ROLES = [
  "SCP Spray Plan Approver",
  "SCP General Manager",
  "System Manager",
  "Administrator",
];

type TabKey = "plans" | "pending" | "history";

function errText(e: unknown): string {
  if (e instanceof FrappeError) return e.message;
  return errorText(e);
}

export function Postponements() {
  const roles = bootstrap().roles || [];
  const canDecide = roles.some((r) => APPROVER_ROLES.includes(r));

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: ToastItem["kind"] = "info") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismiss = useCallback(
    (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
    [],
  );

  const [tab, setTab] = useState<TabKey>(canDecide ? "pending" : "plans");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<PostponementSettings | null>(null);
  const [plans, setPlans] = useState<PostponablePlan[]>([]);
  const [pending, setPending] = useState<Postponement[]>([]);
  const [history, setHistory] = useState<Postponement[]>([]);

  const [target, setTarget] = useState<PostponablePlan | null>(null);
  const [toDate, setToDate] = useState("");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState<Postponement | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [s, p, pend, all] = await Promise.all([
      fetchPostponementSettings(),
      fetchPostponablePlans(),
      listPostponements("Pending"),
      listPostponements(),
    ]);
    setSettings(s);
    setPlans(p);
    setPending(pend);
    setHistory(all.filter((x) => x.status !== "Pending"));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dueToday = useMemo(
    () => plans.filter((p) => p.past_cutoff || !p.request_pending),
    [plans],
  );

  async function submitDeclaration() {
    if (!target) return;
    setBusy(true);
    try {
      await declarePostponement(target.work_order, toDate, reason);
      push("Sent for approval — the plan keeps its date until then", "ok");
      setTarget(null);
      setToDate("");
      setReason("");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    p: Postponement,
    decision: "approve" | "reject",
    why?: string,
  ) {
    setBusy(true);
    try {
      await decidePostponement(p.name, decision, why);
      push(
        decision === "approve"
          ? `Moved to ${p.to_datetime?.slice(0, 16)}`
          : "Refused — the plan keeps its date",
        "ok",
      );
      setRejecting(null);
      setNote("");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Postponed sprays"
        eyebrow={
          settings
            ? `Cutoff ${shortTime(settings.cutoff_time)} · up to ${settings.max_days} days`
            : "Postponement"
        }
        switcher={
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <TabsList>
              <TabsTrigger value="plans">Plans · {dueToday.length}</TabsTrigger>
              <TabsTrigger value="pending">
                Awaiting a decision · {pending.length}
              </TabsTrigger>
              <TabsTrigger value="history">Decided · {history.length}</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <HeaderIconButton
          aria-label="Refresh"
          title="Refresh"
          onClick={() => void load()}
        >
          <RefreshCw className="size-4" />
        </HeaderIconButton>
      </PageHeader>

      <div className="flex flex-col gap-4 px-4 pb-6 md:px-6">
        {settings && (
          <Card>
            <CardContent className="py-3 text-sm text-muted-foreground">
              A plan can be postponed until{" "}
              <strong className="text-foreground">
                {shortTime(settings.cutoff_time)}
              </strong>{" "}
              on its own spray date
              {settings.grace_minutes
                ? `, plus ${settings.grace_minutes} minutes of grace`
                : ""}
              . After the cutoff the spray can no longer be started either — a late
              spray is not one anybody planned for. Nothing moves until an approver
              agrees, and a plan whose tank mix is already made cannot be postponed at
              all.
            </CardContent>
          </Card>
        )}

        {tab === "plans" && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Deadline</TableHead>
                    <TableHead className="w-40" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plans.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-8 text-center text-muted-foreground"
                      >
                        Nothing to postpone — no plan is waiting before its tank mix.
                      </TableCell>
                    </TableRow>
                  )}
                  {plans.map((p) => {
                    const d = describeDeadline(p);
                    return (
                      <TableRow key={p.work_order}>
                        <TableCell>
                          <div className="font-medium">{p.greenhouse || "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {p.work_order}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{p.state}</TableCell>
                        <TableCell className="text-sm">
                          {p.scheduled?.slice(0, 16) || "—"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "flex items-center gap-1 text-xs",
                              d.tone === "ok" && "text-muted-foreground",
                              d.tone === "warn" && "text-amber-600 dark:text-amber-400",
                              d.tone === "gone" && "text-destructive",
                            )}
                          >
                            {d.tone === "ok" ? (
                              <Clock className="size-3.5" />
                            ) : (
                              <AlertTriangle className="size-3.5" />
                            )}
                            {d.text}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {p.request_pending ? (
                            <Badge variant="secondary">request pending</Badge>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || !p.can_postpone}
                              onClick={() => {
                                setTarget(p);
                                setToDate("");
                                setReason("");
                              }}
                            >
                              <CalendarClock className="mr-1 size-4" /> Postpone
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        {tab === "pending" && (
          <div className="flex flex-col gap-3">
            {pending.length === 0 && (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  Nothing awaiting a decision.
                </CardContent>
              </Card>
            )}
            {pending.map((p) => (
              <Card key={p.name}>
                <CardContent className="flex flex-col gap-3 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {p.greenhouse || p.work_order}
                        {p.farm ? (
                          <span className="ml-2 text-sm text-muted-foreground">
                            {p.farm}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-sm">
                        {p.from_datetime?.slice(0, 16)} →{" "}
                        <strong>{p.to_datetime?.slice(0, 16)}</strong>
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {p.declared_by} · {p.reason}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        declared while the plan was {p.state_at_declaration}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {canDecide ? (
                        <>
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void decide(p, "approve")}
                          >
                            <CheckCircle2 className="mr-1 size-4" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setRejecting(p)}
                          >
                            <XCircle className="mr-1 size-4" /> Refuse
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              await withdrawPostponement(p.name);
                              push("Withdrawn", "ok");
                              await load();
                            } catch (e) {
                              push(errText(e), "err");
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Undo2 className="mr-1 size-4" /> Withdraw
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {tab === "history" && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead>What happened</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Decided by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-8 text-center text-muted-foreground"
                      >
                        No decided postponements yet.
                      </TableCell>
                    </TableRow>
                  )}
                  {history.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell>
                        <div className="font-medium">
                          {p.greenhouse || p.work_order}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {p.work_order}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        <Badge
                          variant={
                            p.status === "Approved"
                              ? "default"
                              : p.status === "Rejected"
                                ? "destructive"
                                : "secondary"
                          }
                          className="mr-2"
                        >
                          {p.status}
                        </Badge>
                        {summarisePostponement(p)}
                      </TableCell>
                      <TableCell className="max-w-[18rem] text-sm text-muted-foreground">
                        {p.reason}
                        {p.decision_note ? (
                          <div className="text-xs italic">{p.decision_note}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {p.decided_by || "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Postpone {target?.greenhouse || ""}</DialogTitle>
            <DialogDescription>
              The plan keeps its current date until an approver agrees. Say what
              stopped the spray — that reason is the record of why it slipped.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="text-sm text-muted-foreground">
              Currently {target?.scheduled?.slice(0, 16) || "unscheduled"}
              {settings && target
                ? ` · can move up to ${latestAllowed(target.scheduled, settings.max_days)}`
                : ""}
            </div>
            <Input
              type="datetime-local"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
            <Input
              placeholder="What stopped it? e.g. rain since dawn"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              disabled={busy || !toDate || !reason.trim()}
              onClick={() => void submitDeclaration()}
            >
              Send for approval
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refuse this postponement</DialogTitle>
            <DialogDescription>
              The plan keeps its date, and the refusal stays on the record alongside
              the request.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Why? e.g. spray it this afternoon instead"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            disabled={busy}
            onClick={() => rejecting && void decide(rejecting, "reject", note)}
          >
            Refuse
          </Button>
        </DialogContent>
      </Dialog>

      <Toaster items={toasts} onDismiss={dismiss} />
    </div>
  );
}
