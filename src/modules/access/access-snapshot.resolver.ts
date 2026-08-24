import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import {
  moduleAvailability,
  moduleAvailabilityResolver,
} from "../../common/rbac/module-availability";
import type { AccessSnapshot, DataScope } from "./access.types";
import {
  allCatalogScopes,
  CATALOG_MODULES,
  EMPTY_DENIED_MODULES,
  isPlanGatedModule,
} from "./access-policy";
import { EntitlementsService } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";

export class AccessSnapshotResolver {
  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly mfaPolicy: MfaPolicyService,
    private readonly getPermissionsVersion: (orgId: string) => Promise<number>,
    private readonly resolveUserPermissions: (
      orgId: string,
      userId: string,
    ) => Promise<Map<string, DataScope>>,
    private readonly getUserDeniedModules: (
      orgId: string,
      userId: string,
    ) => Promise<Set<string>>,
    private readonly canManageOrganizationMembership: (
      orgId: string,
      userId: string,
    ) => Promise<boolean>,
  ) {}

  async computeAccessSnapshot(
    orgId: string,
    userId: string,
    currentUserContext: CurrentUserContext,
  ): Promise<AccessSnapshot> {
    const [version, mfa] = await Promise.all([
      this.getPermissionsVersion(orgId),
      this.mfaPolicy.resolve(orgId, userId),
    ]);

    const tokenScopes = currentUserContext.tokenScopes;

    if (currentUserContext.isOrgOwner) {
      const catalog = allCatalogScopes();
      const scopes: Record<string, DataScope> = {};
      for (const [key, scope] of Object.entries(catalog)) {
        if (
          tokenScopes &&
          (!isPersonalTokenPermissionDelegable(key) ||
            !tokenScopes.includes(key))
        )
          continue;
        scopes[key] = scope;
      }
      return {
        scopes,
        modules: await this.resolveModuleFlags(
          orgId,
          userId,
          EMPTY_DENIED_MODULES,
        ),
        isOrgOwner: currentUserContext.isOrgOwner,
        canManageOrganizationMembership: true,
        mfa,
        version,
      };
    }

    const resolved = await this.resolveUserPermissions(orgId, userId);
    const scopes: Record<string, DataScope> = {};
    for (const [key, scope] of resolved) {
      if (scope === "none") continue;
      if (
        tokenScopes &&
        (!isPersonalTokenPermissionDelegable(key) || !tokenScopes.includes(key))
      )
        continue;
      scopes[key] = scope;
    }

    const [denied, canManageOrganizationMembership] = await Promise.all([
      this.getUserDeniedModules(orgId, userId),
      this.canManageOrganizationMembership(orgId, userId),
    ]);
    const modules = await this.resolveModuleFlags(orgId, userId, denied);

    return {
      scopes,
      modules,
      isOrgOwner: currentUserContext.isOrgOwner,
      canManageOrganizationMembership,
      mfa,
      version,
    };
  }

  /** Same inputs `authorize` uses, so the snapshot cannot promise what a request then refuses. */
  private async resolveModuleFlags(
    orgId: string,
    userId: string,
    denied: ReadonlySet<string>,
  ): Promise<Record<string, boolean>> {
    const deniedModules = new Set(denied);
    const effective = await this.entitlements.getEffectiveModuleMap(orgId);
    const resolver = moduleAvailabilityResolver(
      {
        isCoreModule: (moduleKey) =>
          !isPlanGatedModule(moduleKey) || !(moduleKey in effective),
        getModuleMap: async () => effective,
        getPlanLockedModules: async () => [],
      },
      { getUserDeniedModules: async () => deniedModules },
    );

    const modules: Record<string, boolean> = {};
    for (const moduleKey of CATALOG_MODULES) {
      const availability = await moduleAvailability(
        resolver,
        orgId,
        userId,
        moduleKey,
      );
      modules[moduleKey] = availability.available;
    }
    return modules;
  }
}
