import { sql } from "drizzle-orm";

// A total from the page query itself; the fallback is a second statement and must stay off the normal path.
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

export function withoutTotal<T extends { total: unknown }>(
  rows: readonly T[],
): Omit<T, "total">[] {
  return rows.map(({ total: _total, ...rest }) => rest);
}
