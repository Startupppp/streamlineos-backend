import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const ACCOUNTING_JOURNAL_VIEW_PERMISSION = "accounting:journal:read";

export async function resolveAccountingJournalViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  const scope = u.isOrgOwner
    ? "all"
    : !isScopable(ACCOUNTING_JOURNAL_VIEW_PERMISSION)
      ? "all"
      : (await access.resolveUserPermissions(u.orgId, u.userId)).get(ACCOUNTING_JOURNAL_VIEW_PERMISSION) ?? "none";
  return ScopedRead.of(u.orgId, u.userId, scope);
}
