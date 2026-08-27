export class UncountableQuotaError extends Error {}

/**
 * A count is a number or it is nothing. `Number(row?.[col] ?? 0)` collapsed a missing
 * row, a NULL column and a non-numeric value into `0`, and zero against any limit
 * allows the write — so one database hiccup lifted every plan limit at once.
 */
export function readCount(rows: Record<string, unknown>[], column: string): number {
  const row = rows[0];
  if (!row) throw new UncountableQuotaError(`no row returned for "${column}"`);
  const raw = row[column];
  if (raw === null || raw === undefined) throw new UncountableQuotaError(`"${column}" is missing or null`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UncountableQuotaError(`"${column}" is not a number: ${String(raw)}`);
  return value;
}
