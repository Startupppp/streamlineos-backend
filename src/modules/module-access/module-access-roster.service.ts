import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  ilike,
  inArray,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  organizationMembers,
  roleAssignments,
  roles,
  userModuleAccess,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import {
  assertManagedModule,
  assertModuleAccessPolicy,
  moduleAccessPolicyDeps,
} from "./module-access.helpers";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { AccessService } from "../access/access.service";
import type {
  ListMembersQuery,
  MemberCandidatesQuery,
} from "./dto/module-access.schemas";
import type {
  FlatModuleMember,
  MembersPage,
  ModuleMemberCandidate,
  Pagination,
} from "./module-access-groups.types";

@Injectable()
export class ModuleAccessRosterService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async listMembers(
    actor: CurrentUserContext,
    moduleKey: string,
    { page, pageSize, userId, cursor }: ListMembersQuery,
  ): Promise<MembersPage> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      userId === undefined ? "view" : "manage",
    );
    const limit = Math.min(pageSize, 100);
    const version = await this.access.getPermissionsVersion(actor.orgId);
    return this.cache.cached(
      CACHE_KEYS.moduleAccessMembers(
        actor.orgId,
        moduleKey,
        page,
        limit,
        version,
        userId,
        cursor,
      ),
      () => this.fetchMembers(actor.orgId, moduleKey, page, limit, userId, cursor),
      CACHE_TTL.VERY_LONG,
    );
  }

  private async fetchMembers(
    orgId: string,
    moduleKey: string,
    page: number,
    limit: number,
    userId?: string,
    cursor?: number,
  ): Promise<MembersPage> {
    const offset = cursor !== undefined ? 0 : (page - 1) * limit;

    const moduleRoleRows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.moduleKey, moduleKey)));

    if (moduleRoleRows.length === 0) {
      return {
        data: [],
        pagination: { page, pageSize: limit, total: 0, totalPages: 0 },
        nextCursor: null,
      };
    }

    const moduleRoleIds = moduleRoleRows.map((r) => r.id);

    let membershipFilter: SQL | undefined;
    if (userId !== undefined) {
      const target = await this.db.query.organizationMembers.findFirst({
        where: and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, userId),
        ),
        columns: { id: true },
      });
      if (!target) {
        return {
          data: [],
          pagination: { page, pageSize: limit, total: 0, totalPages: 0 },
          nextCursor: null,
        };
      }
      membershipFilter = eq(
        roleAssignments.organizationMembershipId,
        target.id,
      );
    }

    const cursorFilter =
      cursor !== undefined
        ? sql`${organizationMembers.id} > ${cursor}`
        : undefined;

    const baseWhere = and(
      eq(roleAssignments.orgId, orgId),
      inArray(roleAssignments.roleId, moduleRoleIds),
      eq(organizationMembers.status, "ACTIVE"),
      membershipFilter,
      cursorFilter,
    );

    const memberQuery = this.db
      .selectDistinct({
        membershipId: roleAssignments.organizationMembershipId,
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(roleAssignments)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, roleAssignments.orgId),
          eq(
            organizationMembers.id,
            roleAssignments.organizationMembershipId,
          ),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(baseWhere)
      .limit(limit);

    let memberRows: Awaited<typeof memberQuery>;
    let total = 0;

    if (cursor !== undefined) {
      memberRows = await memberQuery.orderBy(
        asc(organizationMembers.id),
      );
    } else {
      const [totalResult, rows] = await Promise.all([
        this.db
          .select({
            total: countDistinct(roleAssignments.organizationMembershipId),
          })
          .from(roleAssignments)
          .innerJoin(
            organizationMembers,
            and(
              eq(organizationMembers.orgId, roleAssignments.orgId),
              eq(
                organizationMembers.id,
                roleAssignments.organizationMembershipId,
              ),
            ),
          )
          .where(baseWhere),
        memberQuery.orderBy(asc(users.name)).offset(offset),
      ]);
      total = Number(totalResult[0]?.total ?? 0);
      memberRows = rows;
    }

    if (memberRows.length === 0) {
      return {
        data: [],
        pagination: {
          page,
          pageSize: limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        nextCursor: null,
      };
    }

    const membershipIds = memberRows.map((r) => r.membershipId);

    const groupRows = await this.db
      .select({
        membershipId: roleAssignments.organizationMembershipId,
        groupId: roles.id,
        groupName: roles.name,
      })
      .from(roleAssignments)
      .innerJoin(
        roles,
        and(eq(roles.id, roleAssignments.roleId), eq(roles.orgId, orgId)),
      )
      .where(
        and(
          eq(roleAssignments.orgId, orgId),
          inArray(roleAssignments.organizationMembershipId, membershipIds),
          inArray(roleAssignments.roleId, moduleRoleIds),
        ),
      );

    const groupsByMembership = new Map<
      number,
      { id: number; name: string }[]
    >();
    for (const gr of groupRows) {
      const list = groupsByMembership.get(gr.membershipId) ?? [];
      list.push({ id: gr.groupId, name: gr.groupName });
      groupsByMembership.set(gr.membershipId, list);
    }

    const data: FlatModuleMember[] = memberRows.map((r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      displayName: r.name ?? r.email ?? r.userId,
      email: r.email ?? "",
      avatarUrl: r.image,
      groups: groupsByMembership.get(r.membershipId) ?? [],
    }));

    const lastMembershipId = memberRows.at(-1)?.membershipId ?? null;
    const nextCursor = memberRows.length === limit ? lastMembershipId : null;

    return {
      data,
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
      nextCursor,
    };
  }

  async listMemberCandidates(
    actor: CurrentUserContext,
    moduleKey: string,
    {
      page,
      pageSize,
      search,
      userId,
      excludeAssigned,
    }: MemberCandidatesQuery = {
      page: 1,
      pageSize: 20,
      search: "",
      excludeAssigned: true,
    },
  ): Promise<{ data: ModuleMemberCandidate[]; pagination: Pagination }> {
    assertManagedModule(moduleKey);
    await assertModuleAccessPolicy(
      moduleAccessPolicyDeps(this.db, this.access),
      actor,
      moduleKey,
      "manage",
    );
    const limit = Math.min(pageSize, 100);
    const offset = (page - 1) * limit;
    const searchPattern = `${search}%`;
    const assignedToModule = this.db
      .select({ value: sql<number>`1` })
      .from(roleAssignments)
      .innerJoin(
        roles,
        and(
          eq(roles.orgId, roleAssignments.orgId),
          eq(roles.id, roleAssignments.roleId),
          eq(roles.moduleKey, moduleKey),
        ),
      )
      .where(
        and(
          eq(roleAssignments.orgId, actor.orgId),
          eq(roleAssignments.organizationMembershipId, organizationMembers.id),
        ),
      );
    const where = and(
      eq(organizationMembers.orgId, actor.orgId),
      eq(organizationMembers.status, "ACTIVE"),
      isNull(userModuleAccess.id),
      excludeAssigned ? notExists(assignedToModule) : undefined,
      userId ? eq(organizationMembers.userId, userId) : undefined,
      search
        ? or(
            ilike(users.name, searchPattern),
            ilike(users.email, searchPattern),
          )
        : undefined,
    );
    const baseJoin = and(
      eq(userModuleAccess.orgId, organizationMembers.orgId),
      eq(userModuleAccess.organizationMembershipId, organizationMembers.id),
      eq(userModuleAccess.moduleKey, moduleKey),
      eq(userModuleAccess.enabled, false),
    );
    const [totalRows, rows] = await Promise.all([
      this.db
        .select({ total: count() })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(userModuleAccess, baseJoin)
        .where(where),
      this.db
        .select({
          userId: organizationMembers.userId,
          name: users.name,
          email: users.email,
          image: users.image,
        })
        .from(organizationMembers)
        .innerJoin(users, eq(organizationMembers.userId, users.id))
        .leftJoin(userModuleAccess, baseJoin)
        .where(where)
        .orderBy(asc(users.name), asc(users.email))
        .limit(limit)
        .offset(offset),
    ]);
    const total = Number(totalRows[0]?.total ?? 0);
    return {
      data: rows.map((row) => ({
        userId: row.userId,
        displayName: row.name ?? row.email ?? row.userId,
        email: row.email ?? "",
        avatarUrl: row.image,
      })),
      pagination: {
        page,
        pageSize: limit,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
      },
    };
  }
}
