import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

export async function resolveExitAdmin(
  access: AccessService,
  user: CurrentUserContext,
  resolvedPermissions?: ReadonlyMap<string, DataScope>,
): Promise<boolean> {
  if (user.isOrgOwner) return true;
  const permissions =
    resolvedPermissions ??
    (await access.resolveUserPermissions(user.orgId, user.userId));
  return permissions.has("hr:exit:manage");
}
