interface Props {
  pendingCount: number
  forwardedCount: number
}

export function HeaderStats({ pendingCount, forwardedCount }: Props) {
  if (!pendingCount && !forwardedCount) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {pendingCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
          {pendingCount} pending
        </span>
      )}
      {forwardedCount > 0 && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {forwardedCount} forwarded
        </span>
      )}
    </div>
  )
}
