import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ScopedRead } from "../../access/scoped-read";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const ACCOUNTING_JOURNAL_VIEW_PERMISSION = "accounting:journal:read";

export async function resolveAccountingJournalViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  if (u.isOrgOwner) return ScopedRead.of(u.orgId, u.userId, "all");
  if (!isScopable(ACCOUNTING_JOURNAL_VIEW_PERMISSION)) return ScopedRead.of(u.orgId, u.userId, "all");
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return ScopedRead.of(u.orgId, u.userId, resolved.get(ACCOUNTING_JOURNAL_VIEW_PERMISSION) ?? "none");
}
