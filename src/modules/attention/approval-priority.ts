/**
 * Derives an inbox priority string for any approval-kind item.
 *
 * `project_approvals` has no priority column. The only honest signals are
 * `status` and `dueAt`:
 *   - `status === "escalated"` means the organisation has already decided
 *     this item warrants elevated attention — that decision IS the priority
 *     signal; it overrides any dueAt calculation.
 *   - A non-null `dueAt` that is strictly in the past means the approver is
 *     overdue — the item should rank ahead of on-schedule work.
 *   - Everything else is NORMAL. Inventing a HIGH rule from weaker signals
 *     (e.g. elapsed calendar time since creation) would require a configurable
 *     threshold we do not have and would differ per adapter kind, defeating
 *     the purpose of a single shared rule.
 *
 * `now` is an injectable parameter defaulting to `new Date()` so callers in
 * tests can make the function deterministic.
 */
export function approvalPriority(
  dueAt: Date | string | null,
  status: string,
  now: Date = new Date(),
): string {
  if (status === "escalated") return "HIGH";
  if (dueAt !== null) {
    const due = dueAt instanceof Date ? dueAt : new Date(dueAt);
    if (due < now) return "HIGH";
  }
  return "NORMAL";
}
