import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const ACCOUNTING_JOURNAL_VIEW_PERMISSION = "accounting:journal:read";

export async function resolveAccountingJournalViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(ACCOUNTING_JOURNAL_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(ACCOUNTING_JOURNAL_VIEW_PERMISSION) ?? "none";
}
