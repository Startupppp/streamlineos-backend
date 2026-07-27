import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  accessVersions,
  departmentMembers,
  departments,
  groupRoles,
  membershipRoleAssignments,
  organizationMembers,
  rolePermissionGrants,
  roles,
  userDelegations,
  userModuleAccess,
  userPermissions,
  userRoles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { logger } from "../../common/logger/logger.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions.constants";
import type { AccessSnapshot, DataScope } from "./access.types";
import { EntitlementsService, MODULE_CATALOG } from "./entitlements.service";

const MANAGEABLE_MODULE_SET: ReadonlySet<string> = new Set(MODULE_CATALOG);

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

function allCatalogScopes(): Record<string, DataScope> {
  const scopes: Record<string, DataScope> = {};
  for (const permission of PERMISSIONS) scopes[permission.name] = "all";
  return scopes;
}

@Injectable()
export class AccessService {
  private missingAccessTablesLogged = false;
  private readonly versionCache = new Map<string, VersionEntry>();
  private readonly permsCache = new Map<string, PermsEntry>();
  private readonly deniedModulesCache = new Map<
    string,
    { modules: Set<string>; expiresAt: number }
  >();
  private static readonly DENIED_MODULES_TTL_MS = 15_000;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private noteMissingAccessTables(error: unknown): void {
    if (this.missingAccessTablesLogged) return;
    this.missingAccessTablesLogged = true;
    logger.warn("access: rbac tables missing, falling back to legacy resolution", {
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

    if (ctx.isPlatformAdmin || ctx.isOrgOwner) {
      const scopes = allCatalogScopes();
      const modules: Record<string, boolean> = {};
      for (const moduleKey of CATALOG_MODULES) modules[moduleKey] = true;
      return {
        permissions: Object.keys(scopes),
        scopes,
        modules,
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

    const moduleMap = await this.entitlements.getModuleMap(orgId);
    const denied = await this.getUserDeniedModules(orgId, userId);
    const modules: Record<string, boolean> = {};
    for (const moduleKey of CATALOG_MODULES) {
      modules[moduleKey] = isInternalModule(moduleKey)
        ? true
        : (moduleMap[moduleKey] ?? true) && !denied.has(moduleKey);
    }

    return { permissions, scopes, modules, isOrgOwner: ctx.isOrgOwner, version };
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

    const membershipRows = await this.safeAccessTableRead(
      () =>
        this.db
          .select({ roleId: membershipRoleAssignments.roleId })
          .from(membershipRoleAssignments)
          .where(
            and(
              eq(membershipRoleAssignments.organizationId, orgId),
              eq(membershipRoleAssignments.organizationMembershipId, membershipId),
            ),
          ),
      [] as { roleId: number }[],
    );

    let directRows: { roleId: number }[];
    let hasDirectRoles: boolean;

    if (membershipRows.length > 0) {
      directRows = membershipRows;
      hasDirectRoles = true;
    } else {
      const userRoleRows = await this.safeAccessTableRead(
        () =>
          this.db
            .select({ roleId: userRoles.roleId })
            .from(userRoles)
            .where(and(eq(userRoles.orgId, orgId), eq(userRoles.userId, userId))),
        [] as { roleId: number }[],
      );
      directRows = userRoleRows;
      hasDirectRoles = directRows.length > 0;
    }

    const roleIds = new Set<number>(directRows.map((row) => row.roleId));

    const deptRows = await this.safeAccessTableRead(
      () =>
        this.db
          .select({ departmentId: departmentMembers.departmentId })
          .from(departmentMembers)
          .innerJoin(departments, eq(departmentMembers.departmentId, departments.id))
          .where(and(eq(departmentMembers.userId, userId), eq(departments.orgId, orgId))),
      [],
    );
    const departmentIds = deptRows.map((row) => row.departmentId);

    if (departmentIds.length > 0) {
      const groupRows = await this.safeAccessTableRead(
        () =>
          this.db
            .select({ roleId: groupRoles.roleId })
            .from(groupRoles)
            .where(
              and(
                eq(groupRoles.orgId, orgId),
                eq(groupRoles.groupType, "department"),
                inArray(groupRoles.groupId, departmentIds),
              ),
            ),
        [],
      );
      for (const row of groupRows) roleIds.add(row.roleId);
    }

    let legacyRoleSlug: string | null = null;
    if (!hasDirectRoles) {
      const user = await this.db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { role: true },
      });
      const slug = user?.role;
      if (slug) {
        const roleRow = await this.db.query.roles.findFirst({
          where: and(eq(roles.slug, slug), eq(roles.orgId, orgId)),
          columns: { id: true },
        });
        if (roleRow) roleIds.add(roleRow.id);
        else legacyRoleSlug = slug;
      }
    }

    const result: Record<string, DataScope> = {};
    const merge = (key: string, scope: DataScope): void => {
      const existing = result[key];
      result[key] = existing ? broadest(existing, scope) : scope;
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
          for (const grant of grants) merge(grant.permissionKey, grant.scope);
          continue;
        }
        const record = roleById.get(roleId);
        const defaults = record ? (ROLE_DEFAULT_PERMISSIONS[record.slug] ?? []) : [];
        for (const key of defaults) merge(key, "all");
      }
    }

    if (legacyRoleSlug) {
      const defaults = ROLE_DEFAULT_PERMISSIONS[legacyRoleSlug] ?? [];
      for (const key of defaults) merge(key, "all");
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
      if (userPerm.permission?.name) merge(userPerm.permission.name, "all");
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
        merge(key, "all");
      }
    }

    return result;
  }
}
