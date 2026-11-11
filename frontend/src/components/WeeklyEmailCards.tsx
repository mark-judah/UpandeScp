/**
 * Preview and "Send test to me" for the weekly spray records email and the
 * avocado scout coverage email. The real emails go out on the weekday chosen in
 * Settings; a test goes to the signed-in user only.
 */
import { useState } from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { previewWeeklyEmail, sendTestWeeklyEmail, type WeeklyEmailKey } from "@/lib/weekly-emails-api";
import { errorText } from "@/lib/errors";

const INFO: Record<WeeklyEmailKey, { title: string; text: string }> = {
  spray_records: {
    title: "Weekly spray records",
    text: "Per farm: location, active ingredient and product sprayed last week, with applications, quantity and last date, and a workbook. Sent to the farm managers and the GM on the day set in Settings.",
  },
  avocado_scout: {
    title: "Weekly avocado scout coverage",
    text: "To the avocado teams: per scout the trees scouted, entries, blocks, active days and distance walked, and the blocks not scouted. Sent on the day set in Settings.",
  },
};

function One({ which }: { which: WeeklyEmailKey }) {
  const [busy, setBusy] = useState<"preview" | "test" | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const info = INFO[which];
  const preview = async () => {
    setBusy("preview");
    setNote(null);
    try {
      setHtml(await previewWeeklyEmail(which));
    } catch (e) {
      setNote({ ok: false, text: errorText(e, "Could not build the preview.") });
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    setNote(null);
    try {
      const r = await sendTestWeeklyEmail(which);
      setNote(
        r.sent
          ? { ok: true, text: `Test email sent to ${r.to}.` }
          : { ok: false, text: r.reason || "Test email was not sent." },
      );
    } catch (e) {
      setNote({ ok: false, text: errorText(e, "Test email failed.") });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4" /> {info.title}
        </CardTitle>
        <CardDescription>{info.text}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={preview} disabled={busy !== null}>
            {busy === "preview" ? "Building…" : "Preview"}
          </Button>
          <Button onClick={test} disabled={busy !== null}>
            {busy === "test" ? "Sending…" : "Send test to me"}
          </Button>
        </div>
        {note && (
          <p className={note.ok ? "text-xs text-[var(--sd-data-green)]" : "text-xs text-[var(--sd-data-red)]"}>
            {note.text}
          </p>
        )}
        {html && (
          <iframe title={`${info.title} email preview`} srcDoc={html} className="h-[520px] w-full rounded-md border bg-white" />
        )}
      </CardContent>
    </Card>
  );
}

export function WeeklyEmailCards({ show }: { show: WeeklyEmailKey[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 px-4 pb-6 md:px-6 lg:grid-cols-2">
      {show.map((k) => (
        <One key={k} which={k} />
      ))}
    </div>
  );
}
