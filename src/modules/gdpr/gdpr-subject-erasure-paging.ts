export const ERASURE_ID_PAGE = 200;

/** Drains every page rather than capping, so a partial erasure cannot report as complete. */
export async function drainIds<T extends { id: number }>(
  pageSize: number,
  page: (cursor: number | null) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: number | null = null;
  for (;;) {
    const rows = await page(cursor);
    all.push(...rows);
    if (rows.length < pageSize) return all;
    const last = rows[rows.length - 1];
    if (!last || last.id === cursor) return all;
    cursor = last.id;
  }
}

/**
 * Keyset-drains owner ids and settles each page's dependent rows before reading the
 * next, so memory stays bounded and a subject past the page size is still fully erased.
 */
export async function forEachIdPage<T extends { id: number }>(
  pageSize: number,
  page: (cursor: number | null) => Promise<T[]>,
  settle: (ids: number[]) => Promise<number>,
): Promise<number> {
  let cursor: number | null = null;
  let settled = 0;
  for (;;) {
    const rows = await page(cursor);
    if (rows.length === 0) return settled;
    settled += await settle(rows.map((row) => row.id));
    if (rows.length < pageSize) return settled;
    const last = rows[rows.length - 1];
    if (!last || last.id === cursor) return settled;
    cursor = last.id;
  }
}
