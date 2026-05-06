interface Props {
  loading: boolean
  children: React.ReactNode
}

export function EmptyHint({ loading, children }: Props) {
  return (
    <div className="flex h-44 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {loading ? "Loading…" : children}
    </div>
  )
}
