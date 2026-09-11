import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The per-borrow statement clock.
 *
 * A pooled connection is borrowed for the whole tenant transaction, so the
 * interesting number is not how long a statement took — it is how long the
 * connection was held while *nothing* was running on it. That is the wall clock
 * between one statement settling and the next one starting, which is exactly
 * what `idle_in_transaction_session_timeout` kills a connection for. The guard
 * was being set and never measured, so a transaction sitting idle for 59 s
 * looked identical to one doing 59 s of query work.
 *
 * This lives in its own module because both `pool-telemetry` (which owns the
 * borrow) and `query-telemetry` (which knows when a statement settles) need it,
 * and `pool-telemetry` already imports from `query-telemetry`. A back-import
 * would close a cycle, and `pnpm check:cycles` is at zero.
 */
export interface BorrowScope {
  startedAt: number;
  statements: number;
  idleMs: number;
  maxIdleGapMs: number;
  lastStatementEndedAt: number | null;
}

const borrowScope = new AsyncLocalStorage<BorrowScope>();

export function createBorrowScope(now: number): BorrowScope {
  return {
    startedAt: now,
    statements: 0,
    idleMs: 0,
    maxIdleGapMs: 0,
    lastStatementEndedAt: null,
  };
}

export function getBorrowScope(): BorrowScope | undefined {
  return borrowScope.getStore();
}

export function runInBorrowScope<T>(scope: BorrowScope, fn: () => Promise<T>): Promise<T> {
  return borrowScope.run(scope, fn);
}

export function exitBorrowScope<T>(fn: () => Promise<T>): Promise<T> {
  return borrowScope.exit(fn);
}

/** Called when a statement is issued; closes the idle gap since the last one. */
export function noteStatementStart(now = Date.now()): void {
  const scope = borrowScope.getStore();
  if (!scope) return;
  scope.statements += 1;
  if (scope.lastStatementEndedAt === null) return;
  const gap = now - scope.lastStatementEndedAt;
  if (gap <= 0) return;
  scope.idleMs += gap;
  if (gap > scope.maxIdleGapMs) scope.maxIdleGapMs = gap;
}

/** Called when a statement settles; the connection is idle-in-transaction from here. */
export function noteStatementEnd(now = Date.now()): void {
  const scope = borrowScope.getStore();
  if (!scope) return;
  scope.lastStatementEndedAt = now;
}
