import { sql } from "drizzle-orm";

/**
 * A list total that costs no extra round trip.
 *
 * Selected alongside the page's own columns, `count(*) OVER ()` reports how many
 * rows the WHERE matched before the LIMIT, so page and total are one scan rather
 * than two statements. The shape is not new here — the read-cost baseline and
 * twenty services already use it; this is the one place it is written down.
 *
 * The window answers from any row of the page, so the only case it cannot serve
 * is an *empty* page. That happens for a genuinely empty list, where the total is
 * zero, or for a reader who navigated past the last page, where a count is the
 * only way left to say how far back to send them. `resolveWindowedTotal` is that
 * distinction, kept in one place so the fallback cannot creep onto the normal
 * path — it is a second statement, and paying for it on every request is exactly
 * what this helper exists to avoid.
 */
export const totalOverWindow = sql<string>`count(*) OVER ()`;

export async function resolveWindowedTotal(
  rows: readonly { readonly total: string | number }[],
  offset: number,
  countBeyondLastPage: () => Promise<number>,
): Promise<number> {
  const first = rows[0];
  if (first) return Number(first.total);
  if (offset === 0) return 0;
  return countBeyondLastPage();
}

/** Drops the window column, which is a paging mechanism and not part of a row. */
export function withoutTotal<T extends { total: unknown }>(
  rows: readonly T[],
): Omit<T, "total">[] {
  return rows.map(({ total: _total, ...rest }) => rest);
}
