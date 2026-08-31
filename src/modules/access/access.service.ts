import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { accessVersions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { subscribeVersionBump } from "../../common/rbac/access-invalidate";
import { accessVersionChannel } from "../../common/rbac/access-version-channel";
import type {
  AccessSnapshot,
  CachedPermissions,
  DataScope,
  PermsEntry,
  VersionEntry,
} from "./access.types";
import { EntitlementsService } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";
import {
  applyUniversalGrants,
  broadest,
  moduleOf,
  stripDeniedModules,
} from "./access-policy";
import { isMissingRelationError } from "./access-error-utils";
import { isPersonalTokenPermissionDelegable } from "../../common/rbac/personal-token-policy";
import { assertNever } from "../../common/auth/principal";
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
  MembershipGateResult,
} from "./access-policy";
const VERSION_CACHE_TTL_MS = 1_000;
const SHARED_VERSION_TTL_SECONDS = 300;
const PERMS_CACHE_TTL_MS = 30_000;
const MEMBERSHIP_CACHE_TTL_MS = 15_000;

function withinCeiling(ceiling: readonly string[], key: string): boolean {
  return isPersonalTokenPermissionDelegable(key) && ceiling.includes(key);
}

@Injectable()
export class AccessService implements OnModuleInit, OnModuleDestroy {
  private missingAccessTablesLogged = false;
  private readonly versionCache = new Map<string, VersionEntry>();
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
  ) {
    const safeAccessTableRead = <Result>(
      read: () => PromiseLike<Result>,
      fallback: Result,
    ): Promise<Result> => this.safeAccessTableRead(read, fallback);
    this.permissionResolver = new AccessPermissionResolver(
      () => this.db,
      safeAccessTableRead,
      this.warnedUnknownKeys,
      this.membershipAccessCache,
      MEMBERSHIP_CACHE_TTL_MS,
      this.clock,
    );
    this.deniedModulesResolver = new DeniedModulesResolver(
      () => this.db,
      safeAccessTableRead,
      (orgId) => this.getPermissionsVersion(orgId),
      (moduleKey) => this.entitlements.isCoreModule(moduleKey),
    );
    this.permissionMembersResolver = new AccessPermissionMembersResolver(
      db,
      cache,
      safeAccessTableRead,
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
    accessVersionChannel.useStore({
      get: (orgId) => this.cache.get<number>(CACHE_KEYS.accessVersion(orgId)),
      set: (orgId, version) =>
        this.cache.set(
          CACHE_KEYS.accessVersion(orgId),
          version,
          SHARED_VERSION_TTL_SECONDS,
        ),
      clear: (orgId) => this.cache.invalidate(CACHE_KEYS.accessVersion(orgId)),
    });
    this.unsubscribeVersionBump = subscribeVersionBump((orgId) => {
      this.versionCache.delete(orgId);
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

  private noteMissingAccessTables(error: unknown): void {
    if (this.missingAccessTablesLogged) return;
    this.missingAccessTablesLogged = true;
    logger.warn("access: rbac tables missing, returning empty permission set", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async safeAccessTableRead<T>(
    read: () => PromiseLike<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await read();
    } catch (error: unknown) {
      if (!isMissingRelationError(error)) throw error;
      this.noteMissingAccessTables(error);
      return fallback;
    }
  }

  private async loadDurablePermissionsVersion(orgId: string): Promise<number> {
    const row = await runInTenantTransaction(
      this.db,
      () =>
        this.safeAccessTableRead(
          () =>
            this.db.query.accessVersions.findFirst({
              where: eq(accessVersions.orgId, orgId),
              columns: { permissionsVersion: true },
            }),
          undefined,
        ),
      { orgId },
    );
    return row?.permissionsVersion ?? 1;
  }

  async getPermissionsVersion(orgId: string): Promise<number> {
    const cached = this.versionCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.version;

    const version = await accessVersionChannel.read(orgId, () =>
      this.loadDurablePermissionsVersion(orgId),
    );

    this.versionCache.set(orgId, {
      version,
      expiresAt: Date.now() + VERSION_CACHE_TTL_MS,
    });
    if (this.versionCache.size > 2000) {
      const now = Date.now();
      for (const [key, entry] of this.versionCache) {
        if (entry.expiresAt <= now) this.versionCache.delete(key);
      }
    }
    return version;
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

  async getAccessSnapshot(
    orgId: string,
    userId: string,
    currentUserContext: CurrentUserContext,
  ): Promise<AccessSnapshot> {
    return runInTenantTransaction(
      this.db,
      () =>
        this.snapshotResolver.computeAccessSnapshot(
          orgId,
          userId,
          currentUserContext,
        ),
      { orgId },
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
    const principal = user.principal;
    switch (principal.kind) {
      case "account-only":
        return "none";
      case "system-job":
        return principal.ceiling.includes(key) ? "all" : "none";
      case "human-session":
        return this.membershipCapability(user, principal.isOrgOwner, key);
      case "personal-token":
        if (!withinCeiling(principal.ceiling, key)) return "none";
        return this.membershipCapability(user, principal.isOrgOwner, key);
      case "agent-token":
        if (!withinCeiling(principal.ceiling, key)) return "none";
        return (
          (await this.resolveUserPermissions(user.orgId, user.userId)).get(
            key,
          ) ?? "none"
        );
      default:
        return assertNever(principal);
    }
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
