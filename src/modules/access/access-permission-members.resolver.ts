import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import {
  groupRoleAssignments,
  moduleOwnerships,
  organizationMembers,
  principalGroupMembers,
  roleAssignments,
  rolePermissionGrants,
  roles,
  userModuleAccess,
} from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { ROLE_DEFAULT_PERMISSIONS } from "../rbac/permissions";
import { isPlanGatedModule } from "./access-policy";
import { namespaceOf } from "../../common/rbac/module-vocabulary";
import type { ReadAccessTable } from "./access-permission.resolver";
import { drainByKeyset, GRANT_PAGE_SIZE } from "../../common/pagination/keyset-drain";

const MEMBERS_WITH_PERMISSION_PAGE_SIZE = 100;

export interface PermissionMember {
  userId: string;
  membershipId: number;
}

interface PermissionMemberPage {
  data: PermissionMember[];
  nextCursor: number;
  exhausted: boolean;
}

export class AccessPermissionMembersResolver {
  constructor(
    private readonly db: Db,
    private readonly cache: CacheService,
    private readonly readAccessTable: ReadAccessTable,
    private readonly getPermissionsVersion: (orgId: string) => Promise<number>,
    private readonly isModuleEnabled: (
      orgId: string,
      moduleKey: string,
    ) => Promise<boolean>,
  ) {}

  async computeMembersWithPermissionCached(
    orgId: string,
    permissionKey: string,
    options?: { limit?: number },
  ): Promise<PermissionMember[]> {
    const permModule = namespaceOf(permissionKey);

    if (isPlanGatedModule(permModule)) {
      const enabled = await this.isModuleEnabled(orgId, permModule);
      if (!enabled) return [];
    }

    const version = await this.getPermissionsVersion(orgId);
    const requestedLimit =
      options?.limit === undefined ? null : Math.max(1, options.limit);
    const result: PermissionMember[] = [];
    let afterMembershipId = 0;
    for (;;) {
      const page = await this.cache.cachedForOrg<PermissionMemberPage>(
        orgId,
        `access:members-with-perm:${permissionKey}:v${version}:a${afterMembershipId}:l${MEMBERS_WITH_PERMISSION_PAGE_SIZE}`,
        () =>
          this.computeMembersWithPermissionPage(
            orgId,
            permissionKey,
            afterMembershipId,
            MEMBERS_WITH_PERMISSION_PAGE_SIZE,
          ),
        CACHE_TTL.SHORT,
      );
      result.push(...page.data);
      if (page.exhausted || page.nextCursor <= afterMembershipId) break;
      if (requestedLimit !== null && result.length >= requestedLimit) break;
      afterMembershipId = page.nextCursor;
    }
    return requestedLimit === null ? result : result.slice(0, requestedLimit);
  }

  private async computeMembersWithPermissionPage(
    orgId: string,
    permissionKey: string,
    afterMembershipId: number,
    limit: number,
  ): Promise<PermissionMemberPage> {
    const permModule = namespaceOf(permissionKey);
    const now = new Date();

    const slugsWithPermInDefaults = Object.entries(ROLE_DEFAULT_PERMISSIONS)
      .filter(([, keys]) => (keys as string[]).includes(permissionKey))
      .map(([slug]) => slug);

    const [
      ownerRows,
      explicitGrantRoleIdRows,
      allExplicitRoleIdRows,
      slugMatchingRoleRows,
      ownershipRows,
    ] = await Promise.all([
      this.readAccessTable(
        () =>
          this.db
            .select({
              userId: organizationMembers.userId,
              membershipId: organizationMembers.id,
            })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.isOwner, true),
                eq(organizationMembers.status, "ACTIVE"),
                gt(organizationMembers.id, afterMembershipId),
              ),
            )
            .orderBy(asc(organizationMembers.id))
            .limit(limit),
      ),

      drainByKeyset(
        0,
        (afterRoleId) =>
          this.readAccessTable(
            () =>
              this.db
                .selectDistinct({ roleId: rolePermissionGrants.roleId })
                .from(rolePermissionGrants)
                .where(
                  and(
                    eq(rolePermissionGrants.orgId, orgId),
                    eq(rolePermissionGrants.permissionKey, permissionKey),
                    gt(rolePermissionGrants.roleId, afterRoleId),
                  ),
                )
                .orderBy(asc(rolePermissionGrants.roleId))
                .limit(GRANT_PAGE_SIZE),
          ),
        (row) => row.roleId,
      ),

      drainByKeyset(
        0,
        (afterRoleId) =>
          this.readAccessTable(
            () =>
              this.db
                .selectDistinct({ roleId: rolePermissionGrants.roleId })
                .from(rolePermissionGrants)
                .where(
                  and(
                    eq(rolePermissionGrants.orgId, orgId),
                    gt(rolePermissionGrants.roleId, afterRoleId),
                  ),
                )
                .orderBy(asc(rolePermissionGrants.roleId))
                .limit(GRANT_PAGE_SIZE),
          ),
        (row) => row.roleId,
      ),

      slugsWithPermInDefaults.length > 0
        ? drainByKeyset(
            0,
            (afterId) =>
              this.readAccessTable(
                () =>
                  this.db
                    .select({ roleId: roles.id })
                    .from(roles)
                    .where(
                      and(
                        eq(roles.orgId, orgId),
                        inArray(roles.slug, slugsWithPermInDefaults),
                        gt(roles.id, afterId),
                      ),
                    )
                    .orderBy(asc(roles.id))
                    .limit(GRANT_PAGE_SIZE),
              ),
            (row) => row.roleId,
          )
        : Promise.resolve([] as { roleId: number }[]),

      this.readAccessTable(
        () =>
          this.db
            .selectDistinct({
              userId: organizationMembers.userId,
              membershipId: organizationMembers.id,
            })
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
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.status, "ACTIVE"),
                gt(organizationMembers.id, afterMembershipId),
              ),
            )
            .orderBy(asc(organizationMembers.id))
            .limit(limit),
      ),
    ]);

    const orgExplicitRoleIds = new Set(
      allExplicitRoleIdRows.map((roleRow) => roleRow.roleId),
    );
    const defaultFallbackRoleIds = slugMatchingRoleRows
      .filter((roleRow) => !orgExplicitRoleIds.has(roleRow.roleId))
      .map((roleRow) => roleRow.roleId);
    const allGrantingRoleIds = [
      ...explicitGrantRoleIdRows.map((roleRow) => roleRow.roleId),
      ...defaultFallbackRoleIds,
    ];

    const [directRoleRows, groupRoleRows] =
      allGrantingRoleIds.length > 0
        ? await Promise.all([
            this.readAccessTable(
              () =>
                this.db
                  .selectDistinct({
                    userId: organizationMembers.userId,
                    membershipId: organizationMembers.id,
                  })
                  .from(organizationMembers)
                  .innerJoin(
                    roleAssignments,
                    and(
                      eq(roleAssignments.orgId, orgId),
                      eq(
                        roleAssignments.organizationMembershipId,
                        organizationMembers.id,
                      ),
                      inArray(roleAssignments.roleId, allGrantingRoleIds),
                      or(
                        isNull(roleAssignments.expiresAt),
                        gt(roleAssignments.expiresAt, now),
                      ),
                    ),
                  )
                  .where(
                    and(
                      eq(organizationMembers.orgId, orgId),
                      eq(organizationMembers.status, "ACTIVE"),
                      gt(organizationMembers.id, afterMembershipId),
                    ),
                  )
                  .orderBy(asc(organizationMembers.id))
                  .limit(limit),
            ),

            this.readAccessTable(
              () =>
                this.db
                  .selectDistinct({
                    userId: organizationMembers.userId,
                    membershipId: organizationMembers.id,
                  })
                  .from(organizationMembers)
                  .innerJoin(
                    principalGroupMembers,
                    and(
                      eq(principalGroupMembers.orgId, orgId),
                      eq(
                        principalGroupMembers.organizationMembershipId,
                        organizationMembers.id,
                      ),
                    ),
                  )
                  .innerJoin(
                    groupRoleAssignments,
                    and(
                      eq(groupRoleAssignments.orgId, orgId),
                      eq(
                        groupRoleAssignments.principalGroupId,
                        principalGroupMembers.principalGroupId,
                      ),
                      inArray(groupRoleAssignments.roleId, allGrantingRoleIds),
                    ),
                  )
                  .where(
                    and(
                      eq(organizationMembers.orgId, orgId),
                      eq(organizationMembers.status, "ACTIVE"),
                      gt(organizationMembers.id, afterMembershipId),
                    ),
                  )
                  .orderBy(asc(organizationMembers.id))
                  .limit(limit),
            ),
          ])
        : [[], []];

    const sourcePages = [
      ownerRows,
      directRoleRows,
      groupRoleRows,
      ownershipRows,
    ];
    const fullPageEnds: number[] = [];
    for (const page of sourcePages) {
      if (page.length !== limit) continue;
      const last = page[page.length - 1];
      if (last) fullPageEnds.push(last.membershipId);
    }
    const merged = sourcePages
      .flat()
      .sort((leftMember, rightMember) => leftMember.membershipId - rightMember.membershipId);
    const scanThrough =
      fullPageEnds.length > 0
        ? Math.min(...fullPageEnds)
        : (merged[merged.length - 1]?.membershipId ?? afterMembershipId);
    const exhausted = fullPageEnds.length === 0;
    const seen = new Set<string>();
    const candidates: PermissionMember[] = [];
    for (const row of merged) {
      if (row.membershipId > scanThrough) break;
      if (!seen.has(row.userId)) {
        seen.add(row.userId);
        candidates.push(row);
      }
    }

    if (candidates.length === 0 || !isPlanGatedModule(permModule)) {
      return { data: candidates, nextCursor: scanThrough, exhausted };
    }

    const deniedRows = await this.readAccessTable(
      () =>
        this.db
          .select({ userId: organizationMembers.userId })
          .from(userModuleAccess)
          // Keyed on the membership now; the candidate list is user ids, so
          // the join is what translates between them.
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.orgId, userModuleAccess.orgId),
              eq(
                organizationMembers.id,
                userModuleAccess.organizationMembershipId,
              ),
            ),
          )
          .where(
            and(
              eq(userModuleAccess.orgId, orgId),
              inArray(
                organizationMembers.userId,
                candidates.map((candidate) => candidate.userId),
              ),
              eq(userModuleAccess.moduleKey, permModule),
              eq(userModuleAccess.enabled, false),
            ),
          )
          .limit(candidates.length),
    );

    if (deniedRows.length === 0) {
      return { data: candidates, nextCursor: scanThrough, exhausted };
    }

    const deniedUserIds = new Set(deniedRows.map((deniedRow) => deniedRow.userId));
    return {
      data: candidates.filter(
        (candidate) => !deniedUserIds.has(candidate.userId),
      ),
      nextCursor: scanThrough,
      exhausted,
    };
  }
}
