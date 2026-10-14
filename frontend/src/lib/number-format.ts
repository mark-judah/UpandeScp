/**
 * The one amount formatter for the Finance page: thousands separators and exactly two
 * decimals, no currency name or symbol anywhere (e.g. 1,309,017.25).
 */
const FMT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatAmount(n: number | null | undefined): string {
  return FMT.format(Number.isFinite(n as number) ? (n as number) : 0);
}
