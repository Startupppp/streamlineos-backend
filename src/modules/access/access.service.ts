import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { subscribeVersionBump } from "../../common/rbac/access-invalidate";
import type {
  AccessSnapshot,
  CachedPermissions,
  DataScope,
  PermsEntry,
} from "./access.types";
import { EntitlementsService } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";
import {
  applyUniversalGrants,
  broadest,
  moduleOf,
  stripDeniedModules,
} from "./access-policy";
import {
  moduleAvailability,
  type ModuleAvailabilityResolver,
  type ModuleAvailabilityResult,
} from "../../common/rbac/module-availability";
import {
  AccessPermissionResolver,
  membershipCacheKey,
  type MembershipAccessState,
} from "./access-permission.resolver";
import {
  type Clock,
  snapshotValidUntil,
  SYSTEM_CLOCK,
} from "./snapshot-validity";
import {
  AccessPermissionMembersResolver,
  type PermissionMember,
} from "./access-permission-members.resolver";
import { AccessSnapshotResolver } from "./access-snapshot.resolver";
import { DeniedModulesResolver } from "./denied-modules.resolver";
import { resolvePrincipalScope } from "./access-principal-scope";
import { AccessVersionCache } from "./access-version-cache";

export {
  broadest,
  evaluateMembershipGate,
  isActiveAssignment,
  isActiveDelegation,
  isPlanGatedModule,
  moduleOf,
  SCOPE_RANK,
} from "./access-policy";
export type {
  DelegationRow,
} from "./access-policy";

const PERMS_CACHE_TTL_MS = 30_000;
const MEMBERSHIP_CACHE_TTL_MS = 15_000;

@Injectable()
export class AccessService implements OnModuleInit, OnModuleDestroy {
  private readonly permsCache = new Map<string, PermsEntry>();
  private readonly membershipAccessCache = new Map<string, MembershipAccessState>();
  private readonly permResolveInFlight = new Map<string, Promise<Map<string, DataScope>>>();
  private unsubscribeVersionBump: (() => void) | null = null;
  private readonly warnedUnknownKeys = new Set<string>();
  private readonly clock: Clock = SYSTEM_CLOCK;
  private readonly permissionResolver: AccessPermissionResolver;
  private readonly permissionMembersResolver: AccessPermissionMembersResolver;
  private readonly snapshotResolver: AccessSnapshotResolver;
  private readonly deniedModulesResolver: DeniedModulesResolver;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly entitlements: EntitlementsService,
    private readonly mfaPolicy: MfaPolicyService,
    private readonly accessVersionCache: AccessVersionCache,
  ) {
    const readAccessTable = <Result>(
      read: () => PromiseLike<Result>,
    ): Promise<Result> => this.readAccessTable(read);
    this.permissionResolver = new AccessPermissionResolver(
      () => this.db,
      readAccessTable,
      this.warnedUnknownKeys,
      this.membershipAccessCache,
      MEMBERSHIP_CACHE_TTL_MS,
      this.clock,
    );
    this.deniedModulesResolver = new DeniedModulesResolver(
      () => this.db,
      readAccessTable,
      (orgId) => this.getPermissionsVersion(orgId),
      (moduleKey) => this.entitlements.isCoreModule(moduleKey),
    );
    this.permissionMembersResolver = new AccessPermissionMembersResolver(
      db,
      cache,
      readAccessTable,
      (organizationId) => this.getPermissionsVersion(organizationId),
      (organizationId, moduleKey) =>
        this.isModuleEnabled(organizationId, moduleKey),
    );
    this.snapshotResolver = new AccessSnapshotResolver(
      entitlements,
      mfaPolicy,
      (organizationId) => this.getPermissionsVersion(organizationId),
      (organizationId, memberUserId) =>
        this.resolveUserPermissions(organizationId, memberUserId),
      (organizationId, memberUserId) =>
        this.getUserDeniedModules(organizationId, memberUserId),
      (organizationId, memberUserId) =>
        this.canManageOrganizationMembership(organizationId, memberUserId),
      (getModuleMap, getDeniedModules) =>
        this.buildModuleAvailabilityResolver(getModuleMap, getDeniedModules),
    );
  }

  onModuleInit(): void {
    this.accessVersionCache.configureStore();
    this.unsubscribeVersionBump = subscribeVersionBump((orgId) => {
      this.accessVersionCache.clearForOrg(orgId);
      this.deleteOrgEntries(this.membershipAccessCache, orgId);
      this.deleteOrgEntries(this.permsCache, orgId);
      this.deniedModulesResolver.clearForOrg(orgId);
      void Promise.all([
        this.cache.invalidateForOrg(orgId, "rbac:members"),
        this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      ]);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeVersionBump?.();
    this.unsubscribeVersionBump = null;
  }

  private deleteOrgEntries<T>(cache: Map<string, T>, orgId: string): void {
    const prefix = `${orgId}:`;
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) cache.delete(key);
    }
  }

  /**
   * Every RBAC read goes through here, and every failure THROWS.
   *
   * It used to swallow anything `isMissingRelationError` matched and return the
   * caller's empty fallback. That predicate is a substring test for
   * "does not exist", so it also caught `column ... does not exist` (schema drift
   * mid-deploy), `role ... does not exist` and `database ... does not exist` — and
   * the resolver reads an empty grants list as "this user holds no permissions".
   * The empty result is then cached for the snapshot's validity window, so one
   * transient failure degrades a user to zero permissions for seconds, with a
   * `warn` fired at most once per process and no error the user can see.
   * On `DeniedModulesResolver` the same fallback is worse than silent: an empty
   * denied-modules list fails OPEN, restoring modules the org took away.
   *
   * Failing closed loudly is the repository's stated policy for exactly this
   * class — `env.validation.ts` forbids `RBAC_MIGRATION_MODE=degrade` in
   * production "because missing entitlement tables must fail closed". A throw
   * reaches `PermissionGuard`, which logs the error with the permission key and
   * denies; nothing is cached, so the next request re-reads. No caller wants the
   * empty array for its own sake: every one of them wants rows, and the fallback
   * parameter is gone so the silent path cannot be reintroduced by passing one.
   */
  private async readAccessTable<T>(read: () => PromiseLike<T>): Promise<T> {
    return read();
  }

  async getPermissionsVersion(orgId: string): Promise<number> {
    return this.accessVersionCache.getVersion(orgId);
  }

  async resolveUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<Map<string, DataScope>> {
    const version = await this.getPermissionsVersion(orgId);
    const permsKey = `${orgId}:${userId}:${version}`;
    const cachedPerms = this.permsCache.get(permsKey);
    const cachedMembership = this.membershipAccessCache.get(
      membershipCacheKey(orgId, userId, version),
    );
    const now = Date.now();

    if (
      cachedPerms &&
      cachedPerms.expiresAt > now &&
      cachedMembership &&
      cachedMembership.expiresAt > now
    ) {
      if (!cachedMembership.active) return new Map();
      const warm = applyUniversalGrants(
        new Map(Object.entries(cachedPerms.perms)),
      );
      if (cachedMembership.isOwnerOrAdmin) return warm;
      const denied = this.deniedModulesResolver.getCached(orgId, userId, version);
      if (denied) {
        stripDeniedModules(warm, denied);
        return warm;
      }
    }

    const existingResolution = this.permResolveInFlight.get(permsKey);
    if (existingResolution) return existingResolution;
    const coldResolution = runInTenantTransaction(
      this.db,
      async () => {
        const txPermsKey = `${orgId}:${userId}:${version}`;
        const local = this.permsCache.get(txPermsKey);
        let map: Map<string, DataScope>;
        if (local && local.expiresAt > this.clock.now().getTime()) {
          map = new Map(Object.entries(local.perms));
        } else {
          const resolved = await this.resolveWithValidity(orgId, userId, version);
          this.permsCache.set(txPermsKey, {
            perms: resolved.perms,
            expiresAt: resolved.validUntil,
          });
          if (this.permsCache.size > 5000) {
            const sweep = this.clock.now().getTime();
            for (const [key, entry] of this.permsCache) {
              if (entry.expiresAt <= sweep) this.permsCache.delete(key);
            }
          }
          map = new Map(Object.entries(resolved.perms));
        }
        const membership = await this.permissionResolver.getMembershipAccessState(
          orgId,
          userId,
          version,
        );
        if (!membership.active) return new Map();
        applyUniversalGrants(map);
        if (membership.isOwnerOrAdmin) return map;
        const denied = await this.deniedModulesResolver.resolve(orgId, userId);
        stripDeniedModules(map, denied);
        return map;
      },
      { orgId },
    );
    this.permResolveInFlight.set(permsKey, coldResolution);
    try {
      return await coldResolution;
    } finally {
      if (this.permResolveInFlight.get(permsKey) === coldResolution)
        this.permResolveInFlight.delete(permsKey);
    }
  }

  async canManageOrganizationMembership(
    orgId: string,
    userId: string,
  ): Promise<boolean> {
    const version = await this.getPermissionsVersion(orgId);
    const cached = this.membershipAccessCache.get(
      membershipCacheKey(orgId, userId, version),
    );
    if (cached && cached.expiresAt > Date.now()) return cached.isOwnerOrAdmin;

    return runInTenantTransaction(
      this.db,
      async () =>
        (
          await this.permissionResolver.getMembershipAccessState(
            orgId,
            userId,
            version,
          )
        ).isOwnerOrAdmin,
      { orgId },
    );
  }

  async getUserDeniedModules(
    orgId: string,
    userId: string,
  ): Promise<Set<string>> {
    return this.deniedModulesResolver.resolve(orgId, userId);
  }

  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    return this.entitlements.isModuleEnabled(orgId, moduleKey);
  }

  isCoreModule(moduleKey: string): boolean {
    return this.entitlements.isCoreModule(moduleKey);
  }

  buildModuleAvailabilityResolver(
    getModuleMap: (orgId: string) => Promise<Record<string, boolean>>,
    getDeniedModules?: (
      orgId: string,
      userId: string,
    ) => Promise<Set<string>>,
  ): ModuleAvailabilityResolver {
    return this.entitlements.buildModuleAvailabilityResolver(
      getModuleMap,
      getDeniedModules ??
        ((orgId, userId) => this.getUserDeniedModules(orgId, userId)),
    );
  }

  async getModuleState(
    orgId: string,
    moduleKey: string,
  ): Promise<boolean | undefined> {
    return this.entitlements.getModuleState(orgId, moduleKey);
  }

  async moduleAvailability(
    user: CurrentUserContext,
    moduleKey: string,
  ): Promise<ModuleAvailabilityResult> {
    return this.moduleAvailabilityFor(user.orgId, user.userId, moduleKey);
  }

  async moduleAvailabilityFor(
    orgId: string,
    userId: string,
    moduleKey: string,
  ): Promise<ModuleAvailabilityResult> {
    return moduleAvailability(
      this.buildModuleAvailabilityResolver((orgId) =>
        this.entitlements.getModuleMap(orgId),
      ),
      orgId,
      userId,
      moduleKey,
    );
  }

  async getPlanLockedModules(orgId: string): Promise<readonly string[]> {
    return this.entitlements.getPlanLockedModules(orgId);
  }

  private static readonly SNAPSHOT_CACHE_TTL_SECONDS = CACHE_TTL.SHORT;

  async getAccessSnapshot(
    orgId: string,
    userId: string,
    currentUserContext: CurrentUserContext,
  ): Promise<AccessSnapshot> {
    const compute = (): Promise<AccessSnapshot> =>
      runInTenantTransaction(
        this.db,
        () =>
          this.snapshotResolver.computeAccessSnapshot(
            orgId,
            userId,
            currentUserContext,
          ),
        { orgId },
      );

    // Token-attenuated requests filter scopes by tokenScopes, so two callers
    // with the same (orgId, userId) may receive different snapshots. Rather than
    // encoding the full scope set in the cache key, skip caching entirely for
    // this path — it is uncommon and correctness dominates.
    if (currentUserContext.tokenScopes !== null) return compute();

    const version = await this.getPermissionsVersion(orgId);
    const localKey = CACHE_KEYS.accessSnapshot(
      userId,
      version,
      currentUserContext.isOrgOwner,
    );
    return this.cache.cachedForOrgWith<AccessSnapshot>(
      orgId,
      localKey,
      compute,
      () => AccessService.SNAPSHOT_CACHE_TTL_SECONDS,
      AccessService.SNAPSHOT_CACHE_TTL_SECONDS,
    );
  }

  private async resolveWithValidity(
    orgId: string,
    userId: string,
    version: number,
  ): Promise<CachedPermissions> {
    const localKey = `access:perms:${userId}:v${version}`;
    const fill = async (): Promise<CachedPermissions> => {
      const now = this.clock.now();
      const resolved = await this.permissionResolver.computeUserPermissions(
        orgId,
        userId,
        version,
      );
      return {
        perms: resolved.perms,
        validUntil: snapshotValidUntil(now, PERMS_CACHE_TTL_MS, resolved.transitions),
      };
    };
    const ttlFn = (result: CachedPermissions): number =>
      Math.floor((result.validUntil - this.clock.now().getTime()) / 1000);

    const cached = await this.cache.cachedForOrgWith<CachedPermissions>(
      orgId,
      localKey,
      fill,
      ttlFn,
      CACHE_TTL.LONG,
    );
    if (cached.validUntil > this.clock.now().getTime()) return cached;

    await this.cache.invalidateForOrg(orgId, localKey);
    return this.cache.cachedForOrgWith<CachedPermissions>(
      orgId,
      localKey,
      fill,
      ttlFn,
      CACHE_TTL.LONG,
    );
  }

  async membersWithPermission(
    orgId: string,
    permissionKey: string,
    options?: { limit?: number },
  ): Promise<PermissionMember[]> {
    return runInTenantTransaction(
      this.db,
      () =>
        this.permissionMembersResolver.computeMembersWithPermissionCached(
          orgId,
          permissionKey,
          options,
        ),
      { orgId },
    );
  }

  async scopeFor(user: CurrentUserContext, key: string): Promise<DataScope> {
    return resolvePrincipalScope(user.principal, key, (isOrgOwner) =>
      this.membershipCapability(user, isOrgOwner, key),
    );
  }

  private async membershipCapability(
    user: CurrentUserContext,
    isOrgOwner: boolean,
    key: string,
  ): Promise<DataScope> {
    if (isOrgOwner) return "all";
    const resolved = await this.resolveUserPermissions(user.orgId, user.userId);
    return resolved.get(key) ?? "none";
  }

  async holds(user: CurrentUserContext, key: string): Promise<boolean> {
    return (await this.scopeFor(user, key)) !== "none";
  }
}
