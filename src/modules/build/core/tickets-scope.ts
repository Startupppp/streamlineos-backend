import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

export const TICKETS_PERMISSION = "build:manage";

export async function resolveTicketsScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, TICKETS_PERMISSION);
}
