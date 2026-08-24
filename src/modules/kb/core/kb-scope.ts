import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";
import { isScopable } from "../../rbac/permissions";

export const KB_ARTICLES_VIEW_PERMISSION = "kb:articles:view";
export const KB_SPACES_VIEW_PERMISSION = "kb:spaces:view";

export async function resolveKbArticlesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(KB_ARTICLES_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(KB_ARTICLES_VIEW_PERMISSION) ?? "none";
}

export async function resolveKbSpacesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  if (u.isOrgOwner) return "all";
  if (!isScopable(KB_SPACES_VIEW_PERMISSION)) return "all";
  const resolved = await access.resolveUserPermissions(u.orgId, u.userId);
  return resolved.get(KB_SPACES_VIEW_PERMISSION) ?? "none";
}
