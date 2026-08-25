import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { DataScope } from "../../access/access.types";
import { AccessService } from "../../access/access.service";

export const KB_ARTICLES_VIEW_PERMISSION = "kb:articles:view";
export const KB_SPACES_VIEW_PERMISSION = "kb:spaces:view";

export async function resolveKbArticlesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, KB_ARTICLES_VIEW_PERMISSION);
}

export async function resolveKbSpacesViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<DataScope> {
  return access.scopeFor(u, KB_SPACES_VIEW_PERMISSION);
}
