import { ClipboardList } from "lucide-react";

/**
 * Avocado Job Sheets — placeholder.
 *
 * Avocado's crop-protection flow is a Work Order of type "Jobsheet", the
 * avocado equivalent of the rose "Application Floor Plan". Not built yet;
 * this is the section's home so the nav is complete while we design it.
 */
export function AvocadoJobSheets() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/80 px-4 py-3 backdrop-blur md:px-6 md:py-4">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-base font-semibold leading-tight">
              Job Sheets
            </h1>
            <p className="text-xs text-muted-foreground">
              Avocado crop-protection work orders
            </p>
          </div>
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-dashed bg-card/50 p-8 text-center">
          <h3 className="text-base font-semibold">Job Sheets — coming next</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            The avocado equivalent of the rose Application Floor Plan, built as
            a Work Order of type <code>Jobsheet</code>. This is its own build
            step.
          </p>
        </div>
      </div>
    </div>
  );
}
