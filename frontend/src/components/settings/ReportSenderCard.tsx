/**
 * Report sender: which outgoing Email Account SCP report, digest and
 * notification emails are sent from, per company. A Default row covers every
 * company without a row of its own (and emails that span companies). Each
 * account shows how many emails it sent in the last hour, what is queued and
 * what failed, with the least busy healthy one marked Suggested, so the GM can
 * see at a glance whether it is already busy. Saved with the rest of the tab.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Mail, RotateCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FilterSelect } from "@/components/FilterSelect";
import {
  fetchReportEmailAccounts,
  type ReportEmailAccount,
  type ReportEmailAccounts,
  type ReportSenderRow,
} from "@/lib/settings-api";
import { errorText } from "@/lib/errors";

function Stat({ n, label, tone }: { n: number; label: string; tone?: "bad" }) {
  return (
    <div className="w-16">
      <div className={`text-lg font-semibold leading-none tabular-nums ${tone === "bad" ? "text-destructive" : ""}`}>
        {n}
      </div>
      <div className="mt-0.5 text-[0.6rem] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}

/** How an account reads inside the picker: address, then what it is carrying. */
export function accountLabel(a: ReportEmailAccount, suggested: boolean): string {
  const load = `${a.last_hour} sent/h, ${a.queued} queued, ${a.failed} failed`;
  return `${a.email_id || a.name} (${load})${suggested ? " - Suggested" : ""}`;
}

function SenderRow({
  title,
  hint,
  value,
  onChange,
  data,
  allLabel,
  onRemove,
  stale,
}: {
  title: string;
  hint?: string;
  value: string;
  onChange: (name: string) => void;
  data: ReportEmailAccounts | null;
  allLabel?: string;
  onRemove?: () => void;
  stale?: boolean;
}) {
  const accounts = data?.accounts ?? [];
  const byName = new Map(accounts.map((a) => [a.name, a]));
  const chosen = byName.get(value);
  const suggested = accounts.length > 1 ? data?.suggested : null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3" data-testid="sender-row">
      <div className="min-w-0 basis-48 flex-1">
        <div className="truncate text-xs font-semibold">{title}</div>
        {hint ? <p className="truncate text-[0.65rem] text-muted-foreground">{hint}</p> : null}
        {stale ? (
          <p className="mt-1 flex items-center gap-1 text-[0.65rem] text-amber-700">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {value} no longer exists or has outgoing email turned off - the default is used instead.
          </p>
        ) : null}
      </div>
      <FilterSelect
        label={`${title} sending account`}
        value={value}
        onChange={onChange}
        allLabel={allLabel}
        options={accounts.map((a) => a.name)}
        format={(n) => {
          const a = byName.get(n);
          return a ? accountLabel(a, suggested === a.name) : n;
        }}
        className="w-72 max-w-full"
      />
      {chosen ? (
        <div className="flex shrink-0 items-start gap-4 text-right">
          {suggested === chosen.name ? (
            <span className="flex items-center gap-1 self-center rounded-full bg-emerald-100 px-2 py-0.5 text-[0.6rem] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
              <Sparkles className="h-3 w-3" />
              Suggested
            </span>
          ) : null}
          <Stat n={chosen.last_hour} label="sent last hour" />
          <Stat n={chosen.queued} label="queued" />
          <Stat n={chosen.failed} label="failed (24h)" tone={chosen.failed ? "bad" : undefined} />
        </div>
      ) : null}
      {chosen?.failed ? (
        <p className="flex w-full items-center gap-1 text-[0.65rem] text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {chosen.failed} failed in the last 24 hours - this account may not deliver.
        </p>
      ) : null}
      {onRemove ? (
        <Button variant="ghost" size="icon" aria-label={`Remove ${title}`} onClick={onRemove}>
          <X className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

export function ReportSenderCard({
  value,
  onChange,
  rows,
  onRowsChange,
}: {
  /** The default account ("" = the site default). */
  value: string;
  onChange: (name: string) => void;
  /** One account per company; a company with no row uses the default. */
  rows: ReportSenderRow[];
  onRowsChange: (rows: ReportSenderRow[]) => void;
}) {
  const [data, setData] = useState<ReportEmailAccounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchReportEmailAccounts());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accounts = data?.accounts ?? [];
  const defaultAccount = accounts.find((a) => a.is_default);
  const known = (name: string) => accounts.some((a) => a.name === name);
  const stale = (name: string) => !!name && !!data && !known(name);
  const taken = new Set(rows.map((r) => r.company));
  const addable = (data?.companies ?? []).filter((c) => !taken.has(c));

  const setRow = (company: string, email_account: string) =>
    onRowsChange(rows.map((r) => (r.company === company ? { ...r, email_account } : r)));

  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Report sender
          </CardTitle>
          <CardDescription>
            The email account SCP emails go out from, per company: the daily
            scouting summary, weekly trap, FCM and greenhouse coverage
            reports, the progress email, scouting alerts, re-entry notices and
            unidentified-pest photos. An email about one company's farms uses
            that company's account; a company with no row, and an email that
            spans several companies, uses the default. Each account shows what
            it sent in the last hour, what is waiting on it, and what failed
            in the last day. The suggested one has no failures and the least
            on it.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {loading && !data ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : (
          <>
            <SenderRow
              title="Default"
              hint={
                defaultAccount
                  ? `Site default is ${defaultAccount.email_id}`
                  : "No default outgoing account is set - emails will not send"
              }
              value={value}
              onChange={onChange}
              data={data}
              allLabel="Site default account"
              stale={stale(value)}
            />
            {rows.map((r) => (
              <SenderRow
                key={r.company}
                title={r.company}
                hint={r.email_account ? undefined : "Pick an account - a row with none is not saved"}
                value={r.email_account}
                onChange={(n) => setRow(r.company, n)}
                data={data}
                stale={stale(r.email_account)}
                onRemove={() => onRowsChange(rows.filter((x) => x.company !== r.company))}
              />
            ))}
            {data && accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No email account has outgoing email turned on.
              </p>
            ) : null}
            {addable.length > 0 ? (
              <div className="pt-1">
                <FilterSelect
                  label="Add company"
                  value=""
                  onChange={(c) => c && onRowsChange([...rows, { company: c, email_account: "" }])}
                  options={addable}
                />
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
