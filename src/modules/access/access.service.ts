import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  accessVersions,
  organizationMembers,
  userModuleAccess,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { UNIVERSAL_MEMBER_PERMISSION_GRANTS } from "../rbac/permissions";

import {
  bumpPermissionsVersion,
  subscribeVersionBump,
} from "../../common/rbac/access-invalidate";
import { ORG_MEMBER_ROLES } from "../../common/rbac/org-roles";
import type { AccessSnapshot, DataScope } from "./access.types";
import { EntitlementsService, MODULE_CATALOG } from "./entitlements.service";
import { MfaPolicyService } from "./mfa-policy.service";
import {
  broadest,
  EMPLOYEE_SELF_SERVICE_GRANTS,
  MANAGEABLE_MODULE_SET,
  moduleOf,
} from "./access-policy";
import {
  AccessPermissionResolver,
  type MembershipAccessState,
} from "./access-permission.resolver";
import {
  AccessPermissionMembersResolver,
  type PermissionMember,
} from "./access-permission-members.resolver";
import { AccessSnapshotResolver } from "./access-snapshot.resolver";

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

interface VersionEntry {
  version: number;
  expiresAt: number;
}

interface PermsEntry {
  perms: Record<string, DataScope>;
  expiresAt: number;
}

const VERSION_CACHE_TTL_MS = 5_000;
const PERMS_CACHE_TTL_MS = 30_000;

function isMissingRelationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "42P01") return true;
  if (
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes("does not exist")
  ) {
    return true;
  }
  if ("cause" in error) return isMissingRelationError(error.cause);
  return false;
}

@Injectable()
export class AccessService implements OnModuleInit, OnModuleDestroy {
  private missingAccessTablesLogged = false;
  private readonly versionCache = new Map<string, VersionEntry>();
  private readonly permsCache = new Map<string, PermsEntry>();
  private readonly deniedModulesCache = new Map<
    string,
    { modules: Set<string>; expiresAt: number }
  >();
  private static readonly DENIED_MODULES_TTL_MS = 15_000;
  private unsubscribeVersionBump: (() => void) | null = null;
  private readonly warnedUnknownKeys = new Set<string>();
  private readonly permissionResolver: AccessPermissionResolver;
  private readonly permissionMembersResolver: AccessPermissionMembersResolver;
  private readonly snapshotResolver: AccessSnapshotResolver;
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
      AccessService.DENIED_MODULES_TTL_MS,
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
    );
  }
  onModuleInit(): void {
    this.unsubscribeVersionBump = subscribeVersionBump((orgId) => {
      this.versionCache.delete(orgId);
      this.deleteOrgEntries(this.membershipAccessCache, orgId);
      this.deleteOrgEntries(this.permsCache, orgId);
      this.deleteOrgEntries(this.deniedModulesCache, orgId);
      void Promise.all([
        // Permission, RBAC, and module-access list keys already include this
        // access version. A bump makes every previous generation unreachable,
        // so scanning Redis to delete it is both redundant and expensive.
        this.cache.invalidate(CACHE_KEYS.rbacDiscoveryMembers(orgId)),
        this.cache.invalidate(CACHE_KEYS.moduleAccessCandidates(orgId)),
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
  async getPermissionsVersion(orgId: string): Promise<number> {
    const cached = this.versionCache.get(orgId);
    if (cached && cached.expiresAt > Date.now()) return cached.version;
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
    const version = row?.permissionsVersion ?? 1;
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
    return runInTenantTransaction(
      this.db,
      async () => {
        const version = await this.getPermissionsVersion(orgId);
        const permsKey = `${orgId}:${userId}:${version}`;
        const local = this.permsCache.get(permsKey);
        let map: Map<string, DataScope>;
        if (local && local.expiresAt > Date.now()) {
          map = new Map(Object.entries(local.perms));
        } else {
          const resolved = await this.cache.cached<Record<string, DataScope>>(
            CACHE_KEYS.accessPerms(orgId, userId, version),
            () => this.computeUserPermissions(orgId, userId),
            CACHE_TTL.LONG,
          );
          this.permsCache.set(permsKey, {
            perms: resolved,
            expiresAt: Date.now() + PERMS_CACHE_TTL_MS,
          });
          if (this.permsCache.size > 5000) {
            const now = Date.now();
            for (const [key, entry] of this.permsCache) {
              if (entry.expiresAt <= now) this.permsCache.delete(key);
            }
          }
          map = new Map(Object.entries(resolved));
        }
        const membership = await this.getMembershipAccessState(orgId, userId);
        if (!membership.active) return new Map();
        for (const grant of UNIVERSAL_MEMBER_PERMISSION_GRANTS) {
          const existing = map.get(grant.permissionKey);
          map.set(
            grant.permissionKey,
            existing ? broadest(existing, grant.scope) : grant.scope,
          );
        }
        for (const grant of EMPLOYEE_SELF_SERVICE_GRANTS) {
          const existing = map.get(grant.permissionKey);
          map.set(
            grant.permissionKey,
            existing ? broadest(existing, grant.scope) : grant.scope,
          );
        }
        if (membership.isOwnerOrAdmin) return map;
        const denied = await this.getUserDeniedModules(orgId, userId);
        if (denied.size > 0) {
          for (const key of Array.from(map.keys())) {
            if (denied.has(moduleOf(key))) map.delete(key);
          }
        }
        return map;
      },
      { orgId },
    );
  }
  private readonly membershipAccessCache = new Map<
    string,
    MembershipAccessState
  >();
  private async getMembershipAccessState(
    orgId: string,
    userId: string,
  ): Promise<{
    exists: boolean;
    active: boolean;
    isOwnerOrAdmin: boolean;
  }> {
    const cacheKey = `${orgId}:${userId}`;
    const cached = this.membershipAccessCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { isOwner: true, role: true, status: true },
    });
    const exists = Boolean(member);
    const active = member?.status === "ACTIVE";
    const isOwnerOrAdmin =
      active &&
      (member?.isOwner === true || member?.role === ORG_MEMBER_ROLES.ORG_ADMIN);
    this.membershipAccessCache.set(cacheKey, {
      exists,
      active,
      isOwnerOrAdmin,
      expiresAt: Date.now() + AccessService.DENIED_MODULES_TTL_MS,
    });
    return { exists, active, isOwnerOrAdmin };
  }
  async canManageOrganizationMembership(
    orgId: string,
    userId: string,
  ): Promise<boolean> {
    return runInTenantTransaction(
      this.db,
      async () =>
        (await this.getMembershipAccessState(orgId, userId)).isOwnerOrAdmin,
      { orgId },
    );
  }
  async getUserDeniedModules(
    orgId: string,
    userId: string,
  ): Promise<Set<string>> {
    const version = await this.getPermissionsVersion(orgId);
    const cacheKey = `${orgId}:${userId}:${version}`;
    const cached = this.deniedModulesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.modules;
    const rows = await runInTenantTransaction(
      this.db,
      () =>
        this.safeAccessTableRead(
          () =>
            this.db
              .select({ moduleKey: userModuleAccess.moduleKey })
              .from(userModuleAccess)
              .where(
                and(
                  eq(userModuleAccess.orgId, orgId),
                  eq(userModuleAccess.userId, userId),
                  eq(userModuleAccess.enabled, false),
                ),
              ),
          [] as { moduleKey: string }[],
        ),
      { orgId },
    );
    const modules = new Set(
      rows
        .map((row) => row.moduleKey)
        .filter((moduleKey) => !this.entitlements.isCoreModule(moduleKey)),
    );
    this.deniedModulesCache.set(cacheKey, {
      modules,
      expiresAt: Date.now() + AccessService.DENIED_MODULES_TTL_MS,
    });
    return modules;
  }
  async getUserModuleAccess(
    orgId: string,
    userId: string,
  ): Promise<{ moduleKey: string; enabled: boolean; core: boolean }[]> {
    const membership = await this.getMembershipAccessState(orgId, userId);
    if (!membership.exists) {
      throw new NotFoundException("User is not a member of this organization");
    }
    const denied = await this.getUserDeniedModules(orgId, userId);
    return MODULE_CATALOG.map((moduleKey) => ({
      moduleKey,
      enabled: !denied.has(moduleKey),
      core: this.entitlements.isCoreModule(moduleKey),
    }));
  }
  async setUserModuleAccess(
    orgId: string,
    userId: string,
    moduleKey: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<{ moduleKey: string; enabled: boolean; core: boolean }[]> {
    if (!MANAGEABLE_MODULE_SET.has(moduleKey)) {
      throw new BadRequestException(`Unknown module "${moduleKey}"`);
    }
    const isCoreModule = this.entitlements.isCoreModule(moduleKey);
    if (isCoreModule) {
      const member = await runInTenantTransaction(
        this.db,
        () =>
          this.db.query.organizationMembers.findFirst({
            where: and(
              eq(organizationMembers.orgId, orgId),
              eq(organizationMembers.userId, userId),
            ),
            columns: { userId: true, status: true },
          }),
        { orgId },
      );
      if (!member) {
        throw new NotFoundException(
          "User is not a member of this organization",
        );
      }
      if (member.status !== "ACTIVE") {
        throw new BadRequestException(
          "Module access can only be changed for active members",
        );
      }
      if (!enabled) {
        throw new BadRequestException(
          `Module "${moduleKey}" is always available to organization members`,
        );
      }
      this.membershipAccessCache.delete(`${orgId}:${userId}`);
      return this.getUserModuleAccess(orgId, userId);
    }
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const member = await tx.query.organizationMembers.findFirst({
          where: and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, userId),
          ),
          columns: { userId: true, status: true },
        });
        if (!member)
          throw new NotFoundException(
            "User is not a member of this organization",
          );
        if (member.status !== "ACTIVE") {
          throw new BadRequestException(
            "Module access can only be changed for active members",
          );
        }
        await tx
          .insert(userModuleAccess)
          .values({ orgId, userId, moduleKey, enabled, updatedBy })
          .onConflictDoUpdate({
            target: [
              userModuleAccess.orgId,
              userModuleAccess.userId,
              userModuleAccess.moduleKey,
            ],
            set: { enabled, updatedBy },
          });
        await bumpPermissionsVersion(tx, orgId);
      },
      { orgId },
    );
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    return this.getUserModuleAccess(orgId, userId);
  }
  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    return this.entitlements.isModuleEnabled(orgId, moduleKey);
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
      {
        orgId,
      },
    );
  }
  private async computeUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<Record<string, DataScope>> {
    return this.permissionResolver.computeUserPermissions(orgId, userId);
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
}
