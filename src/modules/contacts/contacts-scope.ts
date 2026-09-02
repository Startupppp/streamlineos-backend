import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { DataScope } from "../access/access.types";
import { AccessService } from "../access/access.service";

export const CONTACTS_VIEW_PERMISSION = "crm:contacts:view";

export async function resolveContactsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, CONTACTS_VIEW_PERMISSION);
}
