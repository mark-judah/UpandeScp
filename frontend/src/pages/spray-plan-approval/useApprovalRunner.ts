import { useCallback, useState } from "react"

import { scpApi } from "@/lib/scp-api"
import { FrappeError } from "@/lib/frappe"

import { escapeHtml } from "./utils"
import type { LogLine, QrLabel } from "./types"
import type { ProgressState } from "./ProgressPanel"

const initial: ProgressState = {
  open: false,
  mode: "approve",
  title: "",
  percent: 0,
  log: [],
  qrLabels: [],
  canClose: false,
}

function errorMessage(e: unknown): string {
  if (e instanceof FrappeError) return e.message
  if (e instanceof Error) return e.message
  return "Could not connect to server."
}

export function useApprovalRunner(onDone: () => void) {
  const [state, setState] = useState<ProgressState>(initial)
  const [busy, setBusy] = useState(false)

  const reset = useCallback(() => {
    setState((s) => ({ ...s, open: false }))
  }, [])

  const runApprove = useCallback(
    async (woNames: string[]) => {
      if (busy || !woNames.length) return
      setBusy(true)
      const qr: QrLabel[] = []
      const log: LogLine[] = []
      let ok = 0
      let err = 0
      setState({
        open: true,
        mode: "approve",
        title: `Approving ${woNames.length} spray plan${woNames.length !== 1 ? "s" : ""}…`,
        percent: 0,
        log,
        qrLabels: [],
        canClose: false,
      })

      for (let i = 0; i < woNames.length; i++) {
        const wo = woNames[i]
        try {
          const r = await scpApi.sprayPlan.approve(wo)
          if (r.status === "approved") {
            ok++
            log.push({
              kind: "ok",
              html:
                `<strong>${escapeHtml(wo)}</strong> — ` +
                `SE <a href="/app/stock-entry/${escapeHtml(r.se ?? "")}" target="_blank" rel="noreferrer" class="text-emerald-300 underline">${escapeHtml(r.se ?? "")}</a> ` +
                `raised to <strong>${escapeHtml(r.warehouse ?? "WIP")}</strong>` +
                (r.qr_labels?.length
                  ? ` · ${r.qr_labels.length} QR label${r.qr_labels.length > 1 ? "s" : ""}`
                  : ""),
            })
            r.qr_labels?.forEach((lbl) => qr.push({ ...lbl, wo }))
          } else if (r.status === "already_forwarded") {
            ok++
            log.push({
              kind: "warn",
              html: `<strong>${escapeHtml(wo)}</strong> — ${escapeHtml(r.message ?? "Already forwarded.")}`,
            })
          } else if (r.status === "skipped") {
            log.push({
              kind: "skip",
              html: `<strong>${escapeHtml(wo)}</strong> — ${escapeHtml(r.message ?? "Skipped.")}`,
            })
          } else {
            err++
            log.push({
              kind: "err",
              html: `<strong>${escapeHtml(wo)}</strong> — ${escapeHtml(r.message ?? "Unknown error.")}`,
            })
          }
        } catch (e) {
          err++
          log.push({
            kind: "err",
            html: `<strong>${escapeHtml(wo)}</strong> — ${escapeHtml(errorMessage(e))}`,
          })
        }
        setState((s) => ({
          ...s,
          log: [...log],
          qrLabels: [...qr],
          percent: Math.round(((i + 1) / woNames.length) * 100),
        }))
      }

      const titleColor =
        err === 0 ? "#34d399" : err === woNames.length ? "#f87171" : "#fbbf24"
      setState({
        open: true,
        mode: "approve",
        title: `Done — ${ok} approved, ${err} failed.`,
        titleColor,
        percent: 100,
        log,
        qrLabels: qr,
        canClose: true,
      })
      setBusy(false)
      setTimeout(onDone, 800)
    },
    [busy, onDone],
  )

  const runStop = useCallback(
    async (woNames: string[]) => {
      if (busy || !woNames.length) return
      setBusy(true)
      const log: LogLine[] = []
      let ok = 0
      let err = 0
      setState({
        open: true,
        mode: "stop",
        title: `Stopping ${woNames.length} work order${woNames.length !== 1 ? "s" : ""}…`,
        percent: 0,
        log,
        qrLabels: [],
        canClose: false,
      })

      for (let i = 0; i < woNames.length; i++) {
        const wo = woNames[i]
        try {
          const r = await scpApi.sprayPlan.stop(wo)
          if (r.status === "stopped") {
            ok++
            log.push({
              kind: "warn",
              html: `<strong>${escapeHtml(wo)}</strong> — stopped successfully.`,
            })
          } else {
            err++
            log.push({
              kind: "err",
              html: `<strong>${escapeHtml(wo)}</strong> — ${escapeHtml(r.message ?? "Failed.")}`,
            })
          }
        } catch (e) {
          err++
          log.push({
            kind: "err",
            html: `<strong>${escapeHtml(wo)}</strong> — ${escapeHtml(errorMessage(e))}`,
          })
        }
        setState((s) => ({
          ...s,
          log: [...log],
          percent: Math.round(((i + 1) / woNames.length) * 100),
        }))
      }

      const titleColor = err === 0 ? "#f87171" : "#fbbf24"
      setState({
        open: true,
        mode: "stop",
        title: `Done — ${ok} stopped, ${err} failed.`,
        titleColor,
        percent: 100,
        log,
        qrLabels: [],
        canClose: true,
      })
      setBusy(false)
      setTimeout(onDone, 800)
    },
    [busy, onDone],
  )

  return { state, busy, runApprove, runStop, close: reset }
}
