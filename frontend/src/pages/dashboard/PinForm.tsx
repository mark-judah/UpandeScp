import { useState } from "react";

/** Title + shared, then Save pin / Cancel. Shared defaults on (C6). */
export function PinForm({
  defaultTitle,
  busy,
  onSave,
  onCancel,
}: {
  defaultTitle: string;
  busy?: boolean;
  onSave: (title: string, shared: boolean) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [shared, setShared] = useState(true);
  return (
    <form
      data-testid="pin-form"
      className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSave(title.trim(), shared);
      }}
    >
      <input
        aria-label="Pin title"
        value={title}
        maxLength={140}
        onChange={(e) => setTitle(e.target.value)}
        className="min-w-0 flex-1 rounded border bg-card px-2 py-1"
      />
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        Shared
      </label>
      <button
        type="submit"
        disabled={busy || !title.trim()}
        className="rounded border border-primary bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
      >
        Save pin
      </button>
      <button type="button" onClick={onCancel} className="rounded border px-2 py-1 hover:bg-muted">
        Cancel
      </button>
    </form>
  );
}
