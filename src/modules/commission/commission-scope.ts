/**
 * Whose earnings a reader is allowed to ask about.
 *
 * Four lines, and they live in their own file for a structural reason rather
 * than a stylistic one. `CommissionService` and `CommissionAccrualService` both
 * need this rule, and until now the accrual service imported it from the
 * commission service while the commission service imported `recordAccrualForEarning`
 * back from the accrual service — a genuine import cycle, the only one in the
 * backend, and one the root rules say must not exist. `forwardRef` would have
 * hidden it rather than removed it.
 *
 * A pure predicate with no dependencies is exactly the kind of thing that
 * should never have been the reason two services were entangled.
 */

export interface EarningsViewer {
  readonly userId: string;
  /** Whether this reader may look past their own row. */
  readonly viewAll: boolean;
}

/**
 * The user id a query is narrowed to, or null for "no narrowing".
 *
 * A reader without `viewAll` is forced to themselves regardless of what they
 * asked for — the request cannot widen its own scope, which is the whole point.
 * A reader with it may name somebody, and naming nobody means everybody.
 */
/**
 * Which earner's rows a caller may read: their own, one they asked for, or all.
 *
 * Pure and exported so the rule is asserted directly rather than inferred from
 * a mocked WHERE clause. The failure it prevents is specific: a rep holding
 * `crm:commission-earnings:view` at scope `own` passing `?userId=` for a
 * colleague and receiving that colleague's entire compensation, in a request
 * that is authorised at every layer above this one.
 *
 * Returns null only when the caller may see everybody and asked for everybody.
 */
export function earningsUserFilter(
  query: { userId?: string },
  viewer: EarningsViewer,
): string | null {
  if (!viewer.viewAll) return viewer.userId;
  return query.userId ?? null;
}
