/** Format integer cents as a USD string, e.g. 245000 -> "$2,450.00". */
export function formatCents(cents: number, options: { showCents?: boolean } = {}): string {
  const showCents = options.showCents ?? true;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const dollarsStr = dollars.toLocaleString('en-US');
  if (!showCents) return `${sign}$${dollarsStr}`;
  return `${sign}$${dollarsStr}.${remainder.toString().padStart(2, '0')}`;
}

/** Basis points to a percent string, e.g. 250 -> "2.5%". */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, '')}%`;
}
