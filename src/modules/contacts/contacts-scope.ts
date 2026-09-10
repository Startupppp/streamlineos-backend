import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ScopedRead } from "../access/scoped-read";
import { AccessService } from "../access/access.service";

export const CONTACTS_VIEW_PERMISSION = "crm:contacts:view";

export async function resolveContactsViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, CONTACTS_VIEW_PERMISSION);
}
