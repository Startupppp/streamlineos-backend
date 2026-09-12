/** A bare `.limit(N)` on a sweep drops every row past N with no signal; the sweep runs once per window, so what it drops is never picked up. */
export async function drainByKeyset<TRow extends { id: number }>(
  pageSize: number,
  loadPage: (afterId: number) => Promise<TRow[]>,
): Promise<TRow[]> {
  const { rows } = await drainByKeysetBounded<TRow>(
    pageSize,
    Number.POSITIVE_INFINITY,
    (take, after) => loadPage(after?.id ?? 0),
  );
  return rows;
}

export interface BoundedDrain<TRow> {
  rows: TRow[];
  complete: boolean;
}

export async function drainByKeysetBounded<TRow>(
  pageSize: number,
  maxRows: number,
  loadPage: (take: number, after: TRow | undefined) => Promise<TRow[]>,
): Promise<BoundedDrain<TRow>> {
  const rows: TRow[] = [];
  let after: TRow | undefined;
  for (;;) {
    const take = Math.min(pageSize, maxRows - rows.length);
    if (take <= 0) return { rows, complete: false };
    const page = await loadPage(take, after);
    rows.push(...page);
    if (page.length < take) return { rows, complete: true };
    const last = page[page.length - 1];
    if (last === undefined) return { rows, complete: true };
    after = last;
  }
}
