import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  groupRoleAssignments,
  organizationMembers,
  principalGroupMembers,
  principalGroups,
  roles,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { bumpPermissionsVersion } from "../../common/rbac/access-invalidate";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
// NOT `import type`: TypeScript erases a type-only import, so emitDecoratorMetadata
// records `undefined` for this constructor parameter and Nest cannot resolve it — the
// application fails to boot with "argument at index [1]". madge already counts type-only
// imports as edges, so importing the value here introduces no new cycle.
import { AccessService } from "../access/access.service";
import { assertMayAssignRole } from "./assert-role-assignment";
import type {
  AddGroupMemberInput,
  AssignGroupRoleInput,
  CreateGroupInput,
  ListGroupsQuery,
  RenameGroupInput,
} from "./dto/principal-groups.schemas";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { keysetAfterValueUuid } from "../../common/pagination/keyset";
import { isUniqueViolation } from "../../common/db/postgres-error";

@Injectable()
export class PrincipalGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  private async assertGroupBelongsToOrg(orgId: string, groupId: string) {
    const group = await this.db.query.principalGroups.findFirst({
      where: and(
        eq(principalGroups.id, groupId),
        eq(principalGroups.orgId, orgId),
      ),
      columns: { id: true, kind: true },
    });
    if (!group) throw new NotFoundException("Group not found");
    return group;
  }

  async list(orgId: string, query: ListGroupsQuery) {
    const position = decodeCursor(query.cursor);
    const where = and(
      eq(principalGroups.orgId, orgId),
      position ? keysetAfterValueUuid(principalGroups.name, principalGroups.id, position) : undefined,
    );

    const rows = await this.db
        .select({
          id: principalGroups.id,
          name: principalGroups.name,
          kind: principalGroups.kind,
          orgUnitId: principalGroups.orgUnitId,
          createdAt: principalGroups.createdAt,
          memberCount: sql<number>`(
            select count(*)
            from ${principalGroupMembers}
            where ${principalGroupMembers.principalGroupId} = ${principalGroups.id}
              and ${principalGroupMembers.orgId} = ${orgId}
          )`,
          roleCount: sql<number>`(
            select count(*)
            from ${groupRoleAssignments}
            where ${groupRoleAssignments.principalGroupId} = ${principalGroups.id}
              and ${groupRoleAssignments.orgId} = ${orgId}
          )`,
        })
        .from(principalGroups)
        .where(where)
        .orderBy(asc(principalGroups.name), asc(principalGroups.id))
        .limit(query.limit + 1);
    const page = buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.name,
      id: row.id,
    }));
    return {
      data: page.data.map((r) => ({
        ...r,
        memberCount: Number(r.memberCount),
        roleCount: Number(r.roleCount),
      })),
      pagination: page.pagination,
    };
  }

  async create(actor: CurrentUserContext, input: CreateGroupInput) {
    try {
      const [row] = await runInTenantTransaction(
        this.db,
        async (tx) => {
          return tx
            .insert(principalGroups)
            .values({ orgId: actor.orgId, kind: "CUSTOM", name: input.name })
            .returning();
        },
        { orgId: actor.orgId },
      );
      return row;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException(`A group named "${input.name}" already exists`);
      throw err;
    }
  }

  async rename(
    actor: CurrentUserContext,
    groupId: string,
    input: RenameGroupInput,
  ): Promise<{ success: true }> {
    await this.assertGroupBelongsToOrg(actor.orgId, groupId);
    try {
      await runInTenantTransaction(
        this.db,
        async (tx): Promise<void> => {
          await tx
            .update(principalGroups)
            .set({ name: input.name, updatedAt: new Date() })
            .where(
              and(
                eq(principalGroups.id, groupId),
                eq(principalGroups.orgId, actor.orgId),
              ),
            );
        },
        { orgId: actor.orgId },
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException(`A group named "${input.name}" already exists`);
      throw err;
    }
    return { success: true };
  }

  async getMembers(orgId: string, groupId: string) {
    await this.assertGroupBelongsToOrg(orgId, groupId);
    return this.db
      .select({
        membershipId: principalGroupMembers.organizationMembershipId,
        userId: organizationMembers.userId,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(principalGroupMembers)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.orgId, principalGroupMembers.orgId),
          eq(organizationMembers.id, principalGroupMembers.organizationMembershipId),
        ),
      )
      .innerJoin(users, eq(organizationMembers.userId, users.id))
      .where(
        and(
          eq(principalGroupMembers.orgId, orgId),
          eq(principalGroupMembers.principalGroupId, groupId),
        ),
      )
      .limit(100);
  }

  async addMember(
    actor: CurrentUserContext,
    groupId: string,
    input: AddGroupMemberInput,
  ): Promise<{ success: true }> {
    await this.assertGroupBelongsToOrg(actor.orgId, groupId);

    const membership = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, actor.orgId),
        eq(organizationMembers.id, input.membershipId),
        eq(organizationMembers.status, "ACTIVE"),
      ),
      columns: { id: true },
    });
    if (!membership)
      throw new BadRequestException("Membership not found or not active in this organization");

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .insert(principalGroupMembers)
          .values({
            orgId: actor.orgId,
            principalGroupId: groupId,
            organizationMembershipId: input.membershipId,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    return { success: true };
  }

  async removeMember(
    actor: CurrentUserContext,
    groupId: string,
    membershipId: number,
  ): Promise<{ success: true }> {
    await this.assertGroupBelongsToOrg(actor.orgId, groupId);

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .delete(principalGroupMembers)
          .where(
            and(
              eq(principalGroupMembers.orgId, actor.orgId),
              eq(principalGroupMembers.principalGroupId, groupId),
              eq(principalGroupMembers.organizationMembershipId, membershipId),
            ),
          );
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    return { success: true };
  }

  async getAssignedRoles(orgId: string, groupId: string) {
    await this.assertGroupBelongsToOrg(orgId, groupId);
    return this.db
      .select({
        id: roles.id,
        name: roles.name,
        slug: roles.slug,
        rank: roles.rank,
        moduleKey: roles.moduleKey,
      })
      .from(groupRoleAssignments)
      .innerJoin(
        roles,
        and(
          eq(roles.orgId, groupRoleAssignments.orgId),
          eq(roles.id, groupRoleAssignments.roleId),
        ),
      )
      .where(
        and(
          eq(groupRoleAssignments.orgId, orgId),
          eq(groupRoleAssignments.principalGroupId, groupId),
        ),
      )
      .limit(100);
  }

  async assignRole(
    actor: CurrentUserContext,
    groupId: string,
    input: AssignGroupRoleInput,
  ): Promise<{ success: true }> {
    await this.assertGroupBelongsToOrg(actor.orgId, groupId);

    const role = await this.db.query.roles.findFirst({
      where: and(eq(roles.id, input.roleId), eq(roles.orgId, actor.orgId)),
      columns: { id: true, rank: true, moduleKey: true },
    });
    if (!role) throw new NotFoundException("Role not found");

    await assertMayAssignRole(this.db, this.access, actor, role);

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .insert(groupRoleAssignments)
          .values({
            orgId: actor.orgId,
            principalGroupId: groupId,
            roleId: input.roleId,
          })
          .onConflictDoNothing();
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    return { success: true };
  }

  async unassignRole(
    actor: CurrentUserContext,
    groupId: string,
    roleId: number,
  ): Promise<{ success: true }> {
    await this.assertGroupBelongsToOrg(actor.orgId, groupId);

    await runInTenantTransaction(
      this.db,
      async (tx): Promise<void> => {
        await tx
          .delete(groupRoleAssignments)
          .where(
            and(
              eq(groupRoleAssignments.orgId, actor.orgId),
              eq(groupRoleAssignments.principalGroupId, groupId),
              eq(groupRoleAssignments.roleId, roleId),
            ),
          );
        await bumpPermissionsVersion(tx, actor.orgId);
      },
      { orgId: actor.orgId },
    );

    return { success: true };
  }
}
