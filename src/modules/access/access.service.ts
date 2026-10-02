import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { AuthContext } from "../../common/auth/auth-context";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import { subscribeVersionBump } from "../../common/rbac/access-invalidate";
import { logger } from "../../common/logger/logger.service";
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
  type MembershipReader,
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
import { ManagerStandingReader } from "./manager-standing.reader";

export {
  broadest,
  SCOPE_RANK,
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
    private readonly membershipState: MembershipStateService,
    @Optional() managerStanding: ManagerStandingReader | null = null,
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
      (organizationId, memberUserId) =>
        this.membershipState.resolve(memberUserId, organizationId),
      this.clock,
      managerStanding
        ? (organizationId, memberUserId) =>
            managerStanding.managesSomeone(organizationId, memberUserId)
        : null,
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
      (organizationId, memberUserId, authContext) =>
        this.resolveUserPermissions(organizationId, memberUserId, authContext),
      (organizationId, memberUserId) =>
        this.getUserDeniedModules(organizationId, memberUserId),
      (organizationId, memberUserId, authContext) =>
        this.canManageOrganizationMembership(
          organizationId,
          memberUserId,
          authContext,
        ),
      (getModuleMap, getDeniedModules) =>
        this.buildModuleAvailabilityResolver(getModuleMap, getDeniedModules),
    );
  }

  onModuleInit(): void {
    this.unsubscribeVersionBump = subscribeVersionBump((orgId) => {
      this.accessVersionCache.clearForOrg(orgId);
      this.deleteOrgEntries(this.membershipAccessCache, orgId);
      this.deleteOrgEntries(this.permsCache, orgId);
      this.deniedModulesResolver.clearForOrg(orgId);
      void Promise.all([
        this.cache.invalidateForOrg(orgId, "rbac:members"),
        this.cache.invalidateForOrg(orgId, "module-access:candidates"),
      ]).catch((error: unknown) => {
        logger.error("access version bump could not invalidate member list caches", {
          orgId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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

  // Every RBAC read THROWS on failure: an empty grants list reads as "holds nothing", and an empty denied-modules list fails OPEN. Pinned by access-read-failure-throws.spec.ts.
  private async readAccessTable<T>(read: () => PromiseLike<T>): Promise<T> {
    return read();
  }

  async getPermissionsVersion(orgId: string): Promise<number> {
    return this.accessVersionCache.getVersion(orgId);
  }

  /** Only a context bound to this exact actor and tenant may answer for them. */
  private contextFor(
    orgId: string,
    userId: string,
    ctx?: AuthContext,
  ): AuthContext | undefined {
    if (!ctx || ctx.actor.orgId !== orgId || ctx.actor.userId !== userId)
      return undefined;
    return ctx;
  }

  private membershipFrom(
    orgId: string,
    userId: string,
    ctx?: AuthContext,
  ): MembershipReader | undefined {
    const bound = this.contextFor(orgId, userId, ctx);
    return bound ? () => bound.membership() : undefined;
  }

  async resolveUserPermissions(
    orgId: string,
    userId: string,
    ctx?: AuthContext,
  ): Promise<Map<string, DataScope>> {
    const membership = this.membershipFrom(orgId, userId, ctx);
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
          const resolved = await this.resolveWithValidity(
            orgId,
            userId,
            version,
            membership,
          );
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
        const state = await this.permissionResolver.getMembershipAccessState(
          orgId,
          userId,
          version,
          membership,
        );
        if (!state.active) return new Map();
        applyUniversalGrants(map);
        if (state.isOwnerOrAdmin) return map;
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
    ctx?: AuthContext,
  ): Promise<boolean> {
    const version = await this.getPermissionsVersion(orgId);
    const cached = this.membershipAccessCache.get(
      membershipCacheKey(orgId, userId, version),
    );
    if (cached && cached.expiresAt > Date.now()) return cached.isOwnerOrAdmin;

    const membership = this.membershipFrom(orgId, userId, ctx);
    return runInTenantTransaction(
      this.db,
      async () =>
        (
          await this.permissionResolver.getMembershipAccessState(
            orgId,
            userId,
            version,
            membership,
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
    ctx?: AuthContext,
  ): Promise<AccessSnapshot> {
    const bound = this.contextFor(orgId, userId, ctx);
    const compute = (): Promise<AccessSnapshot> =>
      runInTenantTransaction(
        this.db,
        () =>
          this.snapshotResolver.computeAccessSnapshot(
            orgId,
            userId,
            currentUserContext,
            bound,
          ),
        { orgId },
      );

    // Two token-attenuated callers with the same (orgId, userId) get different snapshots, so this path is never cached.
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
    membership?: MembershipReader,
  ): Promise<CachedPermissions> {
    const localKey = `access:perms:${userId}:v${version}`;
    const fill = async (): Promise<CachedPermissions> => {
      const now = this.clock.now();
      const resolved = await this.permissionResolver.computeUserPermissions(
        orgId,
        userId,
        version,
        membership,
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

  async scopeFor(
    user: CurrentUserContext,
    key: string,
    ctx?: AuthContext,
  ): Promise<DataScope> {
    return resolvePrincipalScope(user.principal, key, (isOrgOwner) =>
      this.membershipCapability(user, isOrgOwner, key, ctx),
    );
  }

  private async membershipCapability(
    user: CurrentUserContext,
    isOrgOwner: boolean,
    key: string,
    ctx?: AuthContext,
  ): Promise<DataScope> {
    if (isOrgOwner) return "all";
    const resolved = await this.resolveUserPermissions(
      user.orgId,
      user.userId,
      ctx,
    );
    return resolved.get(key) ?? "none";
  }

  async holds(user: CurrentUserContext, key: string): Promise<boolean> {
    return (await this.scopeFor(user, key)) !== "none";
  }
}
