import type { ScopePredicate } from "../access/access.types";
import { clientAccounts } from "../../db/schema";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";

export function applyClientAccountsScope(scope: DataScope, orgId: string, userId: string): ScopePredicate {
  return applyScope(scope, orgId, userId, { ownerColumn: clientAccounts.salesRepId });
}
