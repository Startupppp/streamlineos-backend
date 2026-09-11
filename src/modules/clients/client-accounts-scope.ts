import { eq, sql, type SQL } from "drizzle-orm";
import { clientAccounts } from "../../db/schema";
import type { ScopedRead, ScopeShape } from "../access/scoped-read";

export const CLIENT_ACCOUNTS_SCOPE: ScopeShape = {
  columns: { ownerColumn: clientAccounts.salesRepId },
};

/**
 * One client account as the caller's read scope sees it. The tenant, the scope
 * and the id arrive together, and a denied scope matches nothing, so a write
 * that looks its target up through this cannot reach a record the same caller
 * could not open.
 */
export function clientAccountWhere(read: ScopedRead, accountId: number): SQL {
  return read.compose(
    {
      tenant: clientAccounts.orgId,
      scope: CLIENT_ACCOUNTS_SCOPE,
      and: [eq(clientAccounts.id, accountId)],
    },
    (where) => where.sql,
    () => sql`false`,
  );
}
