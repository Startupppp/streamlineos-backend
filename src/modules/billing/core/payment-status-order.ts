import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// Providers retry out of order, so an unguarded upsert reverts `captured` to `authorized`.
const PAYMENT_STATUS_RANK: Record<string, number> = {
  created: 0,
  authorized: 1,
  failed: 2,
  captured: 3,
  refunded: 4,
};

export const UNKNOWN_PAYMENT_STATUS_RANK = -1;

export function paymentStatusRank(status: string): number {
  return PAYMENT_STATUS_RANK[status] ?? UNKNOWN_PAYMENT_STATUS_RANK;
}

export function isForwardPaymentTransition(storedStatus: string, incomingStatus: string): boolean {
  return paymentStatusRank(storedStatus) <= paymentStatusRank(incomingStatus);
}

export function forwardOnlyStatusGuard(storedStatus: PgColumn, incomingStatus: string): SQL {
  const branches = Object.entries(PAYMENT_STATUS_RANK).map(
    ([status, rank]) => sql`when ${storedStatus} = ${status} then ${sql.raw(String(rank))}`,
  );
  const storedRank = sql`case ${sql.join(branches, sql` `)} else ${sql.raw(String(UNKNOWN_PAYMENT_STATUS_RANK))} end`;
  return sql`(${storedRank}) <= ${sql.raw(String(paymentStatusRank(incomingStatus)))}`;
}
