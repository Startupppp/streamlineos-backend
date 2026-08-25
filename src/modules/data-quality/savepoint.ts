import { getTenantContext, runWithTenantContext } from "../../common/tenant/tenant-context";

/**
 * Run `fn` inside a SAVEPOINT, with the ambient tenant context pointed at it.
 *
 * Two facts about this codebase make this necessary, and both are easy to get
 * wrong in opposite directions.
 *
 * `this.db` is a Proxy resolving to the request's ambient tenant transaction, so
 * `this.db.transaction(...)` inside a request opens a SAVEPOINT rather than a
 * fresh transaction. That is exactly the tool a bulk operation wants: a
 * statement error aborts the whole transaction and Drizzle takes no per-statement
 * savepoint, so without one, item seven failing costs the other three hundred and
 * ninety-nine.
 *
 * But a nested service resolves *its* `this.db` through the same ambient
 * context, so its writes would go to the outer transaction while the caller
 * believed they were inside the savepoint — and rolling back would leave them
 * committed. Swapping the context for the duration is what makes the isolation
 * real rather than apparent. The `afterCommit` array is shared by reference, so
 * hooks still drain against the request's own commit.
 *
 * With no ambient context — a background sweep, a unit test — there is nothing to
 * nest inside and `fn` runs directly. The caller's try/catch still contains the
 * failure; only the database-level rollback is absent, which is correct, because
 * there is no enclosing transaction for a failure to poison.
 */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const ambient = getTenantContext();
  if (!ambient) return fn();

  return ambient.tx.transaction((savepoint) =>
    runWithTenantContext({ ...ambient, tx: savepoint }, fn),
  );
}
