import { BadRequestException, Inject, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  accessVersions,
  groupRoleAssignments,
  moduleOwnerships,
  organizationMembers,
  permissions,
  principalGroupMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  userDelegations,
  userModuleAccess,
  userPermissions,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ALL_PERMISSION_NAMES, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, moduleScopedPermissions } from "../rbac/permissions";

import { subscribeVersionBump } from "../../common/rbac/access-invalidate";
import type { AccessSnapshot, DataScope } from "./access.types";
import { EntitlementsService, MODULE_CATALOG } from "./entitlements.service";

const MEMBERS_WITH_PERM_DEFAULT_CAP = 50;

const MANAGEABLE_MODULE_SET: ReadonlySet<string> = new Set(MODULE_CATALOG);

const CATALOG_KEY_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_NAMES);

export const SCOPE_RANK: Record<DataScope, number> = { none: 0, own: 1, team: 2, all: 3 };

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

export function broadest(a: DataScope, b: DataScope): DataScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

export interface DelegationRow {
  permissions: string[];
  status: string;
  endsAt: Date;
}

export function isActiveDelegation(row: DelegationRow, now: Date): boolean {
  return row.status === "ACTIVE" && row.endsAt > now;
}

export function isActiveAssignment(row: { expiresAt: Date | null }, now: Date): boolean {
  return row.expiresAt === null || row.expiresAt > now;
}

export function moduleOf(permissionKey: string): string {
  const idx = permissionKey.indexOf(":");
  return idx === -1 ? permissionKey : permissionKey.slice(0, idx);
}

export function isInternalModule(module: string): boolean {
  return module === "settings" || module === "self";
}

export interface MembershipGateResult {
  active: boolean;
  isOwner: boolean;
}

export function evaluateMembershipGate(
  member: { status: string; isOwner: boolean } | null | undefined,
): MembershipGateResult {
  if (!member || member.status !== "ACTIVE") return { active: false, isOwner: false };
  return { active: true, isOwner: member.isOwner };
}

const CATALOG_MODULES = Array.from(new Set(PERMISSIONS.map((permission) => moduleOf(permission.name))));

const EMPTY_DENIED_MODULES: ReadonlySet<string> = new Set<string>();

function allCatalogScopes(): Record<string, DataScope> {
  const scopes: Record<string, DataScope> = {};
  for (const permission of PERMISSIONS) scopes[permission.name] = "all";
  return scopes;
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

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit(): void {
    this.unsubscribeVersionBump = subscribeVersionBump((orgId) => {
      this.versionCache.delete(orgId);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribeVersionBump?.();
    this.unsubscribeVersionBump = null;
  }

  private noteMissingAccessTables(error: unknown): void {
    if (this.missingAccessTablesLogged) return;
    this.missingAccessTablesLogged = true;
    logger.warn("access: rbac tables missing, returning empty permission set", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async safeAccessTableRead<T>(read: () => PromiseLike<T>, fallback: T): Promise<T> {
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

    const row = await this.safeAccessTableRead(
      () =>
        this.db.query.accessVersions.findFirst({
          where: eq(accessVersions.orgId, orgId),
          columns: { permissionsVersion: true },
        }),
      undefined,
    );
    const version = row?.permissionsVersion ?? 1;
    this.versionCache.set(orgId, { version, expiresAt: Date.now() + VERSION_CACHE_TTL_MS });
    if (this.versionCache.size > 2000) {
      const now = Date.now();
      for (const [key, entry] of this.versionCache) {
        if (entry.expiresAt <= now) this.versionCache.delete(key);
      }
    }
    return version;
  }

  async resolveUserPermissions(orgId: string, userId: string): Promise<Map<string, DataScope>> {
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
      this.permsCache.set(permsKey, { perms: resolved, expiresAt: Date.now() + PERMS_CACHE_TTL_MS });
      if (this.permsCache.size > 5000) {
        const now = Date.now();
        for (const [key, entry] of this.permsCache) {
          if (entry.expiresAt <= now) this.permsCache.delete(key);
        }
      }
      map = new Map(Object.entries(resolved));
    }

    const denied = await this.getUserDeniedModules(orgId, userId);
    if (denied.size > 0) {
      for (const key of Array.from(map.keys())) {
        if (denied.has(moduleOf(key))) map.delete(key);
      }
    }
    return map;
  }

  async getUserDeniedModules(orgId: string, userId: string): Promise<Set<string>> {
    const cacheKey = `${orgId}:${userId}`;
    const cached = this.deniedModulesCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.modules;

    const rows = await this.safeAccessTableRead(
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
    );
    const modules = new Set(rows.map((row) => row.moduleKey));
    this.deniedModulesCache.set(cacheKey, {
      modules,
      expiresAt: Date.now() + AccessService.DENIED_MODULES_TTL_MS,
    });
    return modules;
  }

  async getUserModuleAccess(
    orgId: string,
    userId: string,
  ): Promise<{ moduleKey: string; enabled: boolean }[]> {
    const denied = await this.getUserDeniedModules(orgId, userId);
    return MODULE_CATALOG.map((moduleKey) => ({
      moduleKey,
      enabled: !denied.has(moduleKey),
    }));
  }

  async setUserModuleAccess(
    orgId: string,
    userId: string,
    moduleKey: string,
    enabled: boolean,
    updatedBy: string,
  ): Promise<{ moduleKey: string; enabled: boolean }[]> {
    if (!MANAGEABLE_MODULE_SET.has(moduleKey)) {
      throw new BadRequestException(`Unknown module "${moduleKey}"`);
    }
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { userId: true },
    });
    if (!member) throw new NotFoundException("User is not a member of this workspace");

    await this.db
      .insert(userModuleAccess)
      .values({ orgId, userId, moduleKey, enabled, updatedBy })
      .onConflictDoUpdate({
        target: [userModuleAccess.orgId, userModuleAccess.userId, userModuleAccess.moduleKey],
        set: { enabled, updatedBy },
      });

    this.deniedModulesCache.delete(`${orgId}:${userId}`);
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    return this.getUserModuleAccess(orgId, userId);
  }

  async isModuleEnabled(orgId: string, moduleKey: string): Promise<boolean> {
    return this.entitlements.isModuleEnabled(orgId, moduleKey);
  }

  async getAccessSnapshot(
    orgId: string,
    userId: string,
    ctx: CurrentUserContext,
  ): Promise<AccessSnapshot> {
    const version = await this.getPermissionsVersion(orgId);

    if (ctx.isOrgOwner) {
      const scopes = allCatalogScopes();
      return {
        permissions: Object.keys(scopes),
        scopes,
        modules: await this.resolveModuleFlags(orgId, EMPTY_DENIED_MODULES),
        isOrgOwner: ctx.isOrgOwner,
        version,
      };
    }

    const resolved = await this.resolveUserPermissions(orgId, userId);
    const scopes: Record<string, DataScope> = {};
    const permissions: string[] = [];
    for (const [key, scope] of resolved) {
      if (scope === "none") continue;
      scopes[key] = scope;
      permissions.push(key);
    }

    const denied = await this.getUserDeniedModules(orgId, userId);
    const modules = await this.resolveModuleFlags(orgId, denied);

    return { permissions, scopes, modules, isOrgOwner: ctx.isOrgOwner, version };
  }

  /**
   * Module on/off flags for the access snapshot.
   *
   * Only the toggleable catalog modules are subject to org enablement — the
   * remaining permission namespaces (billing, notifications, calendar, …) have
   * no `org_modules` row and are always available. Org enablement is a tenant
   * configuration, not a permission, so owners and platform admins are NOT
   * exempt: they see the modules the org actually turned on and can enable more
   * from Settings → Modules.
   */
  private async resolveModuleFlags(
    orgId: string,
    denied: ReadonlySet<string>,
  ): Promise<Record<string, boolean>> {
    const effective = await this.entitlements.getEffectiveModuleMap(orgId);
    const modules: Record<string, boolean> = {};
    for (const moduleKey of CATALOG_MODULES) {
      if (isInternalModule(moduleKey)) {
        modules[moduleKey] = true;
        continue;
      }
      const orgEnabled = moduleKey in effective ? effective[moduleKey] === true : true;
      modules[moduleKey] = orgEnabled && !denied.has(moduleKey);
    }
    return modules;
  }

  private async computeUserPermissions(
    orgId: string,
    userId: string,
  ): Promise<Record<string, DataScope>> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)),
      columns: { isOwner: true, status: true, id: true },
    });
    const gate = evaluateMembershipGate(member);
    if (!gate.active) return {};
    if (gate.isOwner) return allCatalogScopes();

    const membershipId = member?.id ?? 0;
    const now = new Date();

    const [assignmentRows, groupMemberRows, ownershipRows] = await Promise.all([
      this.safeAccessTableRead(
        () =>
          this.db
            .select({ roleId: roleAssignments.roleId })
            .from(roleAssignments)
            .where(
              and(
                eq(roleAssignments.orgId, orgId),
                eq(roleAssignments.organizationMembershipId, membershipId),
                or(
                  isNull(roleAssignments.expiresAt),
                  gt(roleAssignments.expiresAt, now),
                ),
              ),
            ),
        [] as { roleId: number }[],
      ),
      this.safeAccessTableRead(
        () =>
          this.db
            .select({ principalGroupId: principalGroupMembers.principalGroupId })
            .from(principalGroupMembers)
            .where(
              and(
                eq(principalGroupMembers.orgId, orgId),
                eq(principalGroupMembers.organizationMembershipId, membershipId),
              ),
            ),
        [] as { principalGroupId: string }[],
      ),
      this.safeAccessTableRead(
        () =>
          this.db
            .select({ moduleKey: moduleOwnerships.moduleKey })
            .from(moduleOwnerships)
            .where(
              and(
                eq(moduleOwnerships.orgId, orgId),
                eq(moduleOwnerships.ownerMembershipId, membershipId),
              ),
            ),
        [] as { moduleKey: string }[],
      ),
    ]);

    const roleIds = new Set<number>(assignmentRows.map((row) => row.roleId));

    const groupIds = groupMemberRows.map((row) => row.principalGroupId);

    if (groupIds.length > 0) {
      const groupRoleRows = await this.safeAccessTableRead(
        () =>
          this.db
            .select({ roleId: groupRoleAssignments.roleId })
            .from(groupRoleAssignments)
            .where(
              and(
                eq(groupRoleAssignments.orgId, orgId),
                inArray(groupRoleAssignments.principalGroupId, groupIds),
              ),
            ),
        [] as { roleId: number }[],
      );
      for (const row of groupRoleRows) roleIds.add(row.roleId);
    }

    const result: Record<string, DataScope> = {};
    const merge = (key: string, scope: DataScope): void => {
      const existing = result[key];
      result[key] = existing ? broadest(existing, scope) : scope;
    };
    const mergeIfKnown = (key: string, scope: DataScope, source: string): void => {
      if (CATALOG_KEY_SET.has(key)) {
        merge(key, scope);
        return;
      }
      if (!this.warnedUnknownKeys.has(key)) {
        this.warnedUnknownKeys.add(key);
        logger.warn("access: unknown permission key in grant — absent from catalog, omitted from resolved permissions", {
          orgId, key, source,
        });
      }
    };

    const roleIdList = Array.from(roleIds);
    if (roleIdList.length > 0) {
      const roleRecords = await this.db
        .select({ id: roles.id, slug: roles.slug })
        .from(roles)
        .where(and(eq(roles.orgId, orgId), inArray(roles.id, roleIdList)));
      const roleById = new Map(roleRecords.map((record) => [record.id, record]));

      const grantRows = await this.safeAccessTableRead(
        () =>
          this.db
            .select({
              roleId: rolePermissionGrants.roleId,
              permissionKey: rolePermissionGrants.permissionKey,
              scope: rolePermissionGrants.scope,
            })
            .from(rolePermissionGrants)
            .where(
              and(
                eq(rolePermissionGrants.orgId, orgId),
                inArray(rolePermissionGrants.roleId, roleIdList),
              ),
            ),
        [],
      );
      const grantsByRole = new Map<number, { permissionKey: string; scope: DataScope }[]>();
      for (const grant of grantRows) {
        const list = grantsByRole.get(grant.roleId) ?? [];
        list.push({ permissionKey: grant.permissionKey, scope: grant.scope });
        grantsByRole.set(grant.roleId, list);
      }

      for (const roleId of roleIdList) {
        const grants = grantsByRole.get(roleId);
        if (grants && grants.length > 0) {
          for (const grant of grants) mergeIfKnown(grant.permissionKey, grant.scope, "role-grant");
          continue;
        }
        const record = roleById.get(roleId);
        const defaults = record ? (ROLE_DEFAULT_PERMISSIONS[record.slug] ?? []) : [];
        for (const key of defaults) merge(key, "all");
      }
    }

    const grantedUserPerms = await this.db.query.userPermissions.findMany({
      where: and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.orgId, orgId),
        eq(userPermissions.granted, true),
      ),
      with: { permission: { columns: { name: true } } },
    });
    for (const userPerm of grantedUserPerms) {
      if (userPerm.permission?.name) mergeIfKnown(userPerm.permission.name, "all", "user-permission");
    }

    const delegationRows = await this.safeAccessTableRead(
      () =>
        this.db
          .select({ permissions: userDelegations.permissions })
          .from(userDelegations)
          .where(
            and(
              eq(userDelegations.orgId, orgId),
              eq(userDelegations.delegateeId, userId),
              eq(userDelegations.status, "ACTIVE"),
              gt(userDelegations.endsAt, new Date()),
            ),
          ),
      [] as { permissions: string[] }[],
    );
    for (const row of delegationRows) {
      for (const key of row.permissions) {
        mergeIfKnown(key, "all", "delegation");
      }
    }

    for (const { moduleKey } of ownershipRows) {
      for (const key of moduleScopedPermissions(moduleKey)) {
        merge(key, "all");
      }
    }

    return result;
  }

  async membersWithPermission(
    orgId: string,
    permissionKey: string,
    options?: { limit?: number },
  ): Promise<{ userId: string; membershipId: number }[]> {
    const permModule = moduleOf(permissionKey);

    if (!isInternalModule(permModule)) {
      const enabled = await this.isModuleEnabled(orgId, permModule);
      if (!enabled) return [];
    }

    const limit = Math.max(1, options?.limit ?? MEMBERS_WITH_PERM_DEFAULT_CAP);
    const version = await this.getPermissionsVersion(orgId);
    const cacheKey = CACHE_KEYS.accessMembersWithPerm(orgId, permissionKey, version, limit);

    const result = await this.cache.cached<{ userId: string; membershipId: number }[]>(
      cacheKey,
      () => this.computeMembersWithPermission(orgId, permissionKey, limit),
      CACHE_TTL.SHORT,
    );

    if (result.length >= limit) {
      logger.warn("access: membersWithPermission result may be truncated — raise limit or investigate org size", {
        orgId,
        permissionKey,
        limit,
      });
    }

    return result;
  }

  private async computeMembersWithPermission(
    orgId: string,
    permissionKey: string,
    limit: number,
  ): Promise<{ userId: string; membershipId: number }[]> {
    const permModule = moduleOf(permissionKey);
    const now = new Date();

    const slugsWithPermInDefaults = Object.entries(ROLE_DEFAULT_PERMISSIONS)
      .filter(([, keys]) => (keys as string[]).includes(permissionKey))
      .map(([slug]) => slug);

    const [
      ownerRows,
      explicitGrantRoleIdRows,
      allExplicitRoleIdRows,
      slugMatchingRoleRows,
      userPermRows,
      ownershipRows,
    ] = await Promise.all([
      this.safeAccessTableRead(
        () =>
          this.db
            .select({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.isOwner, true),
                eq(organizationMembers.status, "ACTIVE"),
              ),
            )
            .limit(limit),
        [] as { userId: string; membershipId: number }[],
      ),

      this.safeAccessTableRead(
        () =>
          this.db
            .selectDistinct({ roleId: rolePermissionGrants.roleId })
            .from(rolePermissionGrants)
            .where(
              and(
                eq(rolePermissionGrants.orgId, orgId),
                eq(rolePermissionGrants.permissionKey, permissionKey),
              ),
            ),
        [] as { roleId: number }[],
      ),

      this.safeAccessTableRead(
        () =>
          this.db
            .selectDistinct({ roleId: rolePermissionGrants.roleId })
            .from(rolePermissionGrants)
            .where(eq(rolePermissionGrants.orgId, orgId)),
        [] as { roleId: number }[],
      ),

      slugsWithPermInDefaults.length > 0
        ? this.safeAccessTableRead(
            () =>
              this.db
                .select({ id: roles.id })
                .from(roles)
                .where(and(eq(roles.orgId, orgId), inArray(roles.slug, slugsWithPermInDefaults))),
            [] as { id: number }[],
          )
        : Promise.resolve([] as { id: number }[]),

      this.safeAccessTableRead(
        () =>
          this.db
            .selectDistinct({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
            .from(organizationMembers)
            .innerJoin(
              userPermissions,
              and(
                eq(userPermissions.userId, organizationMembers.userId),
                eq(userPermissions.orgId, orgId),
                eq(userPermissions.granted, true),
              ),
            )
            .innerJoin(
              permissions,
              and(
                eq(permissions.id, userPermissions.permissionId),
                eq(permissions.name, permissionKey),
              ),
            )
            .where(
              and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")),
            )
            .limit(limit),
        [] as { userId: string; membershipId: number }[],
      ),

      this.safeAccessTableRead(
        () =>
          this.db
            .selectDistinct({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
            .from(organizationMembers)
            .innerJoin(
              moduleOwnerships,
              and(
                eq(moduleOwnerships.orgId, orgId),
                eq(moduleOwnerships.ownerMembershipId, organizationMembers.id),
                eq(moduleOwnerships.moduleKey, permModule),
              ),
            )
            .where(
              and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")),
            )
            .limit(limit),
        [] as { userId: string; membershipId: number }[],
      ),
    ]);

    const orgExplicitRoleIds = new Set(allExplicitRoleIdRows.map((r) => r.roleId));
    const defaultFallbackRoleIds = slugMatchingRoleRows
      .filter((r) => !orgExplicitRoleIds.has(r.id))
      .map((r) => r.id);
    const allGrantingRoleIds = [
      ...explicitGrantRoleIdRows.map((r) => r.roleId),
      ...defaultFallbackRoleIds,
    ];

    const [directRoleRows, groupRoleRows] = allGrantingRoleIds.length > 0
      ? await Promise.all([
          this.safeAccessTableRead(
            () =>
              this.db
                .selectDistinct({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
                .from(organizationMembers)
                .innerJoin(
                  roleAssignments,
                  and(
                    eq(roleAssignments.orgId, orgId),
                    eq(roleAssignments.organizationMembershipId, organizationMembers.id),
                    inArray(roleAssignments.roleId, allGrantingRoleIds),
                    or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, now)),
                  ),
                )
                .where(
                  and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")),
                )
                .limit(limit),
            [] as { userId: string; membershipId: number }[],
          ),

          this.safeAccessTableRead(
            () =>
              this.db
                .selectDistinct({ userId: organizationMembers.userId, membershipId: organizationMembers.id })
                .from(organizationMembers)
                .innerJoin(
                  principalGroupMembers,
                  and(
                    eq(principalGroupMembers.orgId, orgId),
                    eq(principalGroupMembers.organizationMembershipId, organizationMembers.id),
                  ),
                )
                .innerJoin(
                  groupRoleAssignments,
                  and(
                    eq(groupRoleAssignments.orgId, orgId),
                    eq(groupRoleAssignments.principalGroupId, principalGroupMembers.principalGroupId),
                    inArray(groupRoleAssignments.roleId, allGrantingRoleIds),
                  ),
                )
                .where(
                  and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.status, "ACTIVE")),
                )
                .limit(limit),
            [] as { userId: string; membershipId: number }[],
          ),
        ])
      : [[], []];

    const seen = new Set<string>();
    const candidates: { userId: string; membershipId: number }[] = [];
    for (const row of [
      ...ownerRows,
      ...directRoleRows,
      ...groupRoleRows,
      ...userPermRows,
      ...ownershipRows,
    ]) {
      if (!seen.has(row.userId)) {
        seen.add(row.userId);
        candidates.push(row);
        if (candidates.length >= limit) break;
      }
    }

    if (candidates.length === 0 || isInternalModule(permModule)) return candidates;

    const deniedRows = await this.safeAccessTableRead(
      () =>
        this.db
          .select({ userId: userModuleAccess.userId })
          .from(userModuleAccess)
          .where(
            and(
              eq(userModuleAccess.orgId, orgId),
              inArray(
                userModuleAccess.userId,
                candidates.map((c) => c.userId),
              ),
              eq(userModuleAccess.moduleKey, permModule),
              eq(userModuleAccess.enabled, false),
            ),
          ),
      [] as { userId: string }[],
    );

    if (deniedRows.length === 0) return candidates;

    const deniedUserIds = new Set(deniedRows.map((r) => r.userId));
    return candidates.filter((c) => !deniedUserIds.has(c.userId));
  }
}
