/**
 * "Issue list (PDF)" — the storeman's printable list of what to issue on a
 * spray day. A pill opens a small popover: the day (default today), the farms
 * and greenhouses (empty = all), and a download button.
 */
import { useEffect, useMemo, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { DatePicker } from "@/components/DatePicker";
import { PlaceMultiPicker } from "@/components/PlaceMultiPicker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { call } from "@/lib/frappe";
import { downloadBase64Pdf } from "@/lib/labels-api";
import { errorText } from "@/lib/errors";
import { EMPTY_PLACE_SET, encodeNames, type FarmHouses, type PlaceSet } from "@/lib/places";
import { cn } from "@/lib/utils";

const API = "upande_scp.serverscripts.store.issue_list_pdf";

interface IssueListPdf {
  data: string;
  filename: string;
  to_issue: number;
  issued: number;
}

const unwrap = <T,>(r: any): T => (r && r.message !== undefined ? r.message : r) as T;

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** farms + greenhouses → request params (whole farms sent as farms). */
export function issueListParams(date: string, places: PlaceSet) {
  return {
    date,
    farms: encodeNames(places.farms) || undefined,
    greenhouses: encodeNames(places.greenhouses) || undefined,
  };
}

export function IssueListPdfButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [places, setPlaces] = useState<PlaceSet>(EMPTY_PLACE_SET);
  const [farmMap, setFarmMap] = useState<FarmHouses>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!open || Object.keys(farmMap).length) return;
    call(`${API}.issue_list_places`)
      .then((r) => {
        const p = unwrap<{ farms: string[]; greenhouses_by_farm: FarmHouses }>(r);
        setFarmMap(Object.fromEntries((p.farms || []).map((f) => [f, p.greenhouses_by_farm?.[f] || []])));
      })
      .catch(() => {});
  }, [open, farmMap]);

  const farms = useMemo(() => farmMap, [farmMap]);

  const download = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = unwrap<IssueListPdf>(await call(`${API}.download_issue_list_pdf`, issueListParams(date, places)));
      downloadBase64Pdf(r.data, r.filename);
      setNote({ kind: "ok", text: `${r.to_issue} to issue, ${r.issued} already issued.` });
    } catch (e) {
      setNote({ kind: "err", text: errorText(e, "Could not build the issue list") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(HEADER_PILL, className)} aria-label="Issue list (PDF)">
          <FileDown className="h-3.5 w-3.5" />
          Issue list (PDF)
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3" aria-label="Issue list options">
        <p className="text-xs text-muted-foreground">
          Everything to issue for the spray day, by farm and greenhouse, with a pick list to print.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <DatePicker value={date} onChange={setDate} label="Spray day" />
          <PlaceMultiPicker farms={farms} value={places} onChange={setPlaces} remember={false} label="Issue list farms" />
        </div>
        <Button type="button" size="sm" className="w-full rounded-full" onClick={download} disabled={busy || !date}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
          Download PDF
        </Button>
        {note && (
          <p role="status" className={cn("text-xs", note.kind === "err" ? "text-destructive" : "text-muted-foreground")}>
            {note.text}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
