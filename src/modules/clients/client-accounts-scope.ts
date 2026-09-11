import { clientAccounts } from "../../db/schema";
import type { ScopeShape } from "../access/scoped-read";

export const CLIENT_ACCOUNTS_SCOPE: ScopeShape = {
  columns: { ownerColumn: clientAccounts.salesRepId },
};
