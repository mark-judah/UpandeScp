import { Printer, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { openQrPrintWindow } from "./QrPrintSheet"
import type { LogLine, QrLabel } from "./types"

export interface ProgressState {
  open: boolean
  mode: "approve" | "stop"
  title: string
  titleColor?: string
  percent: number
  log: LogLine[]
  qrLabels: QrLabel[]
  canClose: boolean
}

interface Props {
  state: ProgressState
  onClose: () => void
}

const KIND_CLASS: Record<LogLine["kind"], string> = {
  ok: "text-emerald-400",
  warn: "text-amber-300",
  err: "text-red-400",
  skip: "text-slate-400",
}

const KIND_GLYPH: Record<LogLine["kind"], string> = {
  ok: "✓",
  warn: "ℹ",
  err: "✗",
  skip: "—",
}

export function ProgressPanel({ state, onClose }: Props) {
  if (!state.open) return null
  const isStop = state.mode === "stop"

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 mx-auto max-w-5xl rounded-t-lg border border-b-0 border-slate-700 bg-slate-900 text-slate-100 shadow-2xl">
      <div className="flex items-center justify-between gap-2 border-b border-slate-700 px-4 py-3">
        <div
          className="text-sm font-semibold"
          style={state.titleColor ? { color: state.titleColor } : undefined}
        >
          {state.title}
        </div>
        {state.canClose && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={onClose}
          >
            <X className="mr-1 size-3.5" /> Close
          </Button>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden bg-slate-800">
        <div
          className={cn(
            "h-full transition-all duration-300",
            isStop ? "bg-red-500" : "bg-emerald-500",
          )}
          style={{ width: `${state.percent}%` }}
        />
      </div>
      <div className="max-h-44 overflow-y-auto px-4 py-2 font-mono text-xs">
        {state.log.length === 0 ? (
          <div className="py-2 text-slate-500">Starting…</div>
        ) : (
          state.log.map((l, i) => (
            <div key={i} className={cn("flex gap-2 py-0.5", KIND_CLASS[l.kind])}>
              <span className="shrink-0">{KIND_GLYPH[l.kind]}</span>
              <span
                className="break-words"
                // log entries originate from us and contain controlled markup
                // (work-order names, SE links). Source values are escaped at
                // the runner level before being concatenated.
                dangerouslySetInnerHTML={{ __html: l.html }}
              />
            </div>
          ))
        )}
      </div>
      {state.qrLabels.length > 0 && (
        <div className="border-t border-slate-700 bg-slate-950/60 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-200">
              {state.qrLabels.length} QR label
              {state.qrLabels.length !== 1 ? "s" : ""} generated
            </div>
            <Button
              type="button"
              size="sm"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={() => openQrPrintWindow(state.qrLabels)}
            >
              <Printer className="mr-1 size-3.5" /> Print Labels
            </Button>
          </div>
          <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-1">
            {state.qrLabels.slice(0, 8).map((lbl, i) => (
              <div
                key={`${lbl.chemical}-${i}`}
                className="flex shrink-0 items-center gap-2 rounded-md bg-slate-900 px-2 py-1.5 ring-1 ring-slate-700"
              >
                <img
                  src={`data:image/png;base64,${lbl.png_base64}`}
                  alt=""
                  className="size-10 [image-rendering:pixelated]"
                />
                <div className="text-[10px] leading-tight">
                  <div className="max-w-[120px] truncate font-semibold text-slate-100">
                    {lbl.chemical}
                  </div>
                  <div className="text-slate-400">
                    {lbl.qty} {lbl.uom}
                  </div>
                </div>
              </div>
            ))}
            {state.qrLabels.length > 8 && (
              <div className="shrink-0 text-xs text-slate-400">
                +{state.qrLabels.length - 8} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
