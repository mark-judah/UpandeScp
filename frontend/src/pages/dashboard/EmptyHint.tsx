import { Card } from "@/components/ui/card";

export function EmptyHint({
  title = "No data in this range",
  hint = "Adjust the filters or expand the date range.",
}: {
  title?: string;
  hint?: string;
}) {
  return (
    <Card className="p-6 flex flex-col items-center justify-center gap-1 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{hint}</div>
    </Card>
  );
}
