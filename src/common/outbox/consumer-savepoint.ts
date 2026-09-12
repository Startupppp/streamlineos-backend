import {
  getTenantContext,
  runWithTenantContext,
} from "../tenant/tenant-context";

// PostgreSQL aborts the whole transaction on a failed statement, so a caught error is only
// recoverable behind a SAVEPOINT — which is what a nested postgres-js transaction is.
export function runInConsumerSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const context = getTenantContext();
  if (!context || typeof context.tx.transaction !== "function") return fn();
  return context.tx.transaction((savepointTx) =>
    runWithTenantContext({ ...context, tx: savepointTx }, fn),
  );
}
