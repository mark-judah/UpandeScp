/** The roses page's toast helpers, shared by the plan form's dialogs: a statement on one
 *  line and, for a server error, what to do on the next. */
import type { ToastApi, ToastItem } from "@/components/Toast";
import { asStatement, explainError } from "@/lib/errors";

export function usePlanToasts(toast: ToastApi) {
  const pushToast = (kind: ToastItem["kind"], text: string, autoMs?: number, hint?: string) =>
    toast.show(asStatement(text), kind, { hint, ms: autoMs });
  const pushError = (e: unknown, fallback?: string) => {
    const h = explainError(e, fallback);
    return pushToast("err", h.text, h.kind === "bug" ? 12000 : 8000, h.hint);
  };
  return { pushToast, pushError, dismissToast: toast.dismiss };
}
