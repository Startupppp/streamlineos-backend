/** A bare `.limit(N)` on a sweep drops every row past N with no signal; the sweep runs once per window, so what it drops is never picked up. */
export async function drainByKeyset<TRow extends { id: number }>(
  pageSize: number,
  loadPage: (afterId: number) => Promise<TRow[]>,
): Promise<TRow[]> {
  const drained: TRow[] = [];
  let afterId = 0;
  for (;;) {
    const page = await loadPage(afterId);
    drained.push(...page);
    if (page.length < pageSize) return drained;
    const last = page[page.length - 1];
    if (!last) return drained;
    afterId = last.id;
  }
}
