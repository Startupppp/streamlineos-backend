import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AuthContext } from "../../common/auth/auth-context";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import { ALL_PERMISSION_NAMES } from "../rbac/permissions";
import type { AuthResult, DataScope } from "./access.types";
import type { ModuleAvailabilityResolver } from "../../common/rbac/module-availability";

export interface AccessScopeResolver {
  scopeFor(
    user: CurrentUserContext,
    key: string,
    ctx?: AuthContext,
  ): Promise<DataScope>;
}

export interface AccessResolver extends AccessScopeResolver {
  getModuleState(orgId: string, moduleKey: string): Promise<boolean | undefined>;
  buildModuleAvailabilityResolver: (
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
    getDeniedModules?: (orgId: string, userId: string) => Promise<Set<string>>,
  ) => ModuleAvailabilityResolver;
}

/** Built once; the catalogue is a module-level constant. */
const CATALOGUED_KEYS = new Set(ALL_PERMISSION_NAMES);

export async function authorize(
  access: AccessScopeResolver,
  ctx: AuthContext | null,
  permissionKey: string,
): Promise<AuthResult> {
  if (!ctx) return { allow: false, scope: "none", reason: "UNAUTHENTICATED" };

  /*
    A key nobody catalogued is denied before anything else looks at it.

    `isCoreModuleKey` answers true for a namespace with no registry entry,
    deliberately: `settings:` and `ownership:` are platform surfaces with no
    org-module toggle. But a typo has no registry entry either, and the two were
    indistinguishable -- so `nonexistent:ghost:action` resolved as core, hence
    always available, and an org owner (who holds ALL_PERMISSION_NAMES by
    `role-defaults`) got scope "all" and was allowed through.

    That is a permission system failing open, on precisely the input it cannot
    reason about. The catalogue is the list of keys that mean something, and
    `gated-keys-are-catalogued.spec.ts` already guarantees every real
    `@RequirePermission` appears in it, so nothing legitimate is refused here.

    The reason is FORBIDDEN rather than NO_MODULE. NO_MODULE becomes a 402 that
    tells the caller to enable a module, and there is no module to enable — the
    key means nothing. A client acting on that answer would send somebody to a
    billing page over a typo, and the frontend's denied-versus-empty handling
    reads this reason to decide which of the two it is looking at.
  */
  if (!CATALOGUED_KEYS.has(permissionKey)) {
    return { allow: false, scope: "none", reason: "FORBIDDEN" };
  }

  // namespaceOf, never administeringModuleOf: Home administers `chat:*` and is always enabled, so that swap would keep `chat:*` live for an org with Chat disabled.
  const avail = await ctx.moduleAvailable(namespaceOf(permissionKey));
  if (!avail.available) return { allow: false, scope: "none", reason: "NO_MODULE" };

  const scope = await access.scopeFor(ctx.actor, permissionKey, ctx);
  if (scope === "none") return { allow: false, scope: "none", reason: "FORBIDDEN" };

  return { allow: true, scope };
}
