import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HEADER_PILL } from "@/components/header-controls";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/errors";
import {
  getSprayTicket,
  sprayTicketPrintUrl,
  type SprayTicket,
  type TicketGroup,
  type TicketLine,
} from "@/lib/spray-ticket-api";

const SECTIONS: { group: TicketGroup; title: string }[] = [
  { group: "details", title: "Details" },
  { group: "signoff", title: "Sign-offs" },
  { group: "spray", title: "Spray" },
];

const R = 26;
const CIRC = 2 * Math.PI * R;

function Ring({ percent }: { percent: number }) {
  return (
    <div className="relative h-16 w-16 shrink-0" role="img" aria-label={`${percent}% complete`}>
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle cx="32" cy="32" r={R} fill="none" strokeWidth="5" className="stroke-muted" />
        <circle
          cx="32"
          cy="32"
          r={R}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          className="stroke-foreground"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - percent / 100)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
        {percent}%
      </span>
    </div>
  );
}

function Line({ line }: { line: TicketLine }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/60 py-1.5 text-sm last:border-0">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{line.label}</div>
      {line.filled ? (
        <div className="whitespace-pre-line break-words">{line.value}</div>
      ) : (
        <div className="text-muted-foreground">
          {line.value && <div className="whitespace-pre-line">{line.value}</div>}
          <span className="italic">{line.hint ?? "Not filled"}</span>
        </div>
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-3" data-testid="ticket-skeleton">
      <div className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 rounded-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export function SprayTicketDialog({
  workOrder,
  onClose,
}: {
  workOrder: string | null;
  onClose: () => void;
}) {
  const [ticket, setTicket] = useState<SprayTicket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workOrder) return;
    let live = true;
    setTicket(null);
    setError(null);
    getSprayTicket(workOrder)
      .then((t) => live && setTicket(t))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [workOrder]);

  return (
    <Dialog open={!!workOrder} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Spray ticket</DialogTitle>
          <DialogDescription className="font-mono text-xs">{workOrder}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : !ticket ? (
          <Loading />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <Ring percent={ticket.percent} />
              <div className="min-w-0 flex-1 text-sm">
                {ticket.missing.length === 0 ? (
                  <p>Every line is filled.</p>
                ) : (
                  <>
                    <p className="font-medium">Still missing</p>
                    <p className="text-muted-foreground" data-testid="missing-list">
                      {ticket.missing.join(", ")}
                    </p>
                  </>
                )}
                {ticket.stopped && <p className="mt-1 text-destructive">This plan was stopped.</p>}
              </div>
              {ticket.printable ? (
                <Button asChild variant="outline" className={HEADER_PILL}>
                  <a href={sprayTicketPrintUrl(ticket.work_order)} target="_blank" rel="noreferrer">
                    <Printer className="mr-1.5 h-4 w-4" />
                    Print
                  </a>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled
                  className={HEADER_PILL}
                  title={
                    ticket.missing.length
                      ? `Complete first: ${ticket.missing.join(", ")}`
                      : "A stopped plan cannot be printed"
                  }
                >
                  <Printer className="mr-1.5 h-4 w-4" />
                  Print
                </Button>
              )}
            </div>

            {SECTIONS.map(({ group, title }) => {
              const rows = ticket.lines.filter((l) => l.group === group);
              if (!rows.length) return null;
              return (
                <section key={group}>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide">{title}</h3>
                  <div>
                    {rows.map((l) => (
                      <Line key={l.key} line={l} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
