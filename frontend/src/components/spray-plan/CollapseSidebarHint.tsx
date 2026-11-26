/**
 * A one-line hint on the field Application Floor Plan: collapse the app sidebar to
 * give the block panel more room. While it shows, the sidebar's Collapse button is
 * pointed out (a pulsing ring). Dismissible and remembered in this browser; not shown
 * when the sidebar is already collapsed, on a phone (the sidebar is a drawer there), or
 * outside the app shell.
 */
import { useEffect, useState } from "react";
import { PanelLeftClose } from "lucide-react";
import { useOptionalSidebar } from "@/components/ui/sidebar";

export const COLLAPSE_HINT_KEY = "scp.hint.collapseSidebar.dismissed";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function CollapseSidebarHint() {
  const sidebar = useOptionalSidebar();
  const [dismissed, setDismissed] = useState(readDismissed);
  const show = !!sidebar && !sidebar.isMobile && sidebar.state === "expanded" && !dismissed;
  const setHighlight = sidebar?.setHighlightCollapse;

  useEffect(() => {
    if (!setHighlight) return;
    setHighlight(show);
    return () => setHighlight(false);
  }, [show, setHighlight]);

  if (!show || !sidebar) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(COLLAPSE_HINT_KEY, "1");
    } catch {
      /* private mode: the hint just comes back next time */
    }
  };

  return (
    <div
      role="status"
      data-testid="collapse-sidebar-hint"
      className="flex flex-wrap items-center gap-2 rounded-full bg-card px-4 py-2 text-xs shadow-[var(--sd-shadow-1)]"
    >
      <PanelLeftClose className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1 min-w-0">Collapse the sidebar to give the block plans more room.</span>
      <button
        type="button"
        onClick={() => sidebar.setOpen(false)}
        className="rounded-full bg-foreground px-3 py-1 font-medium text-background hover:opacity-90"
      >
        Collapse sidebar
      </button>
      <button type="button" onClick={dismiss} className="rounded-full px-2 py-1 text-muted-foreground hover:text-foreground">
        Dismiss
      </button>
    </div>
  );
}
