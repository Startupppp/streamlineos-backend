import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  moduleAvailability,
} from "../../common/rbac/module-availability";
import { moduleOf } from "./access.service";
import type { AuthResult, DataScope } from "./access.types";
import type { ModuleAvailabilityResolver } from "../../common/rbac/module-availability";

export interface AccessResolver {
  scopeFor(user: CurrentUserContext, key: string): Promise<DataScope>;
  getModuleState(orgId: string, moduleKey: string): Promise<boolean | undefined>;
  buildModuleAvailabilityResolver: (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
  ) => ModuleAvailabilityResolver;
}

export async function authorize(
  access: AccessResolver,
  ctx: CurrentUserContext | null,
  permissionKey: string,
): Promise<AuthResult> {
  if (!ctx) return { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

  const moduleKey = moduleOf(permissionKey);
  const getModuleMap = async (orgId: string): Promise<Record<string, boolean>> => {
    const state = await access.getModuleState(orgId, moduleKey);
    if (state === undefined) return {};
    return { [moduleKey]: state };
  };

  const resolver = access.buildModuleAvailabilityResolver(getModuleMap);

  const avail = await moduleAvailability(resolver, ctx.orgId, ctx.userId, moduleKey);
  if (!avail.available) return { allow: false, scope: "none", reason: "NO_MODULE" };

  const scope = await access.scopeFor(ctx, permissionKey);
  if (scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}
