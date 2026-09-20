import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  pmWorkspaceMemberships,
  pmWorkspaces,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetAfterId } from "../../../common/pagination/keyset";
import { bumpPermissionsVersion } from "../../../common/rbac/access-invalidate";
import type {
  AddWorkspaceMemberInput,
  ListMembersQuery,
  UpdateMemberRoleInput,
} from "./dto/pm-workspaces.schemas";
import { isUniqueViolation } from "../../../common/db/postgres-error";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

@Injectable()
export class PmWorkspaceMembershipsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async assertWorkspaceExists(
    orgId: string,
    pmWorkspaceId: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ pmWorkspaceId: pmWorkspaces.pmWorkspaceId })
      .from(pmWorkspaces)
      .where(
        and(
          eq(pmWorkspaces.pmWorkspaceId, pmWorkspaceId),
          eq(pmWorkspaces.orgId, orgId),
          isNull(pmWorkspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("PM workspace not found");
  }

  private async assertNotLastAdmin(
    tx: Tx,
    orgId: string,
    pmWorkspaceId: string,
    errorMessage: string,
  ): Promise<void> {
    const admins = await tx
      .select({ id: pmWorkspaceMemberships.pmWorkspaceMembershipId })
      .from(pmWorkspaceMemberships)
      .where(
        and(
          eq(pmWorkspaceMemberships.orgId, orgId),
          eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
          eq(pmWorkspaceMemberships.role, "admin"),
        ),
      )
      .limit(2);
    if (admins.length <= 1) throw new ForbiddenException(errorMessage);
  }

  async listMembers(
    orgId: string,
    pmWorkspaceId: string,
    query: ListMembersQuery,
  ) {
    await this.assertWorkspaceExists(orgId, pmWorkspaceId);
    const { cursor, limit } = query;
    const pos = decodeCursor(cursor);
    const conds = [
      eq(pmWorkspaceMemberships.orgId, orgId),
      eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
      ...(query.userId ? [eq(organizationMembers.userId, query.userId)] : []),
    ];
    if (pos) conds.push(keysetAfterId(pmWorkspaceMemberships.addedAt, pmWorkspaceMemberships.organizationMembershipId, pos));

    const rows = await this.db
      .select({
        pmWorkspaceMembershipId: pmWorkspaceMemberships.pmWorkspaceMembershipId,
        orgId: pmWorkspaceMemberships.orgId,
        pmWorkspaceId: pmWorkspaceMemberships.pmWorkspaceId,
        organizationMembershipId: pmWorkspaceMemberships.organizationMembershipId,
        userId: organizationMembers.userId,
        role: pmWorkspaceMemberships.role,
        addedAt: pmWorkspaceMemberships.addedAt,
      })
      .from(pmWorkspaceMemberships)
      .innerJoin(
        organizationMembers,
        eq(pmWorkspaceMemberships.organizationMembershipId, organizationMembers.id),
      )
      .where(and(...conds))
      .orderBy(asc(pmWorkspaceMemberships.addedAt), asc(pmWorkspaceMemberships.organizationMembershipId))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (r) => ({
      sortValue: (r.addedAt ?? new Date(0)).toISOString(),
      id: String(r.organizationMembershipId),
    }));
  }

  async addMember(
    orgId: string,
    actorUserId: string,
    pmWorkspaceId: string,
    input: AddWorkspaceMemberInput,
  ) {
    await this.assertWorkspaceExists(orgId, pmWorkspaceId);
    const [member] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, input.userId),
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!member) {
      throw new NotFoundException(
        "User is not an active member of this organization",
      );
    }
    const [row] = await this.db
      .insert(pmWorkspaceMemberships)
      .values({
        orgId,
        pmWorkspaceId,
        organizationMembershipId: member.id,
        role: input.role,
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            "This member is already in the workspace.",
          );
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to add workspace member");
    await bumpPermissionsVersion(this.db, orgId);
    this.audit.log({
      action: "pm_workspace.member.added",
      userId: actorUserId,
      orgId,
      resourceType: "pm_workspace_membership",
      resourceId: row.pmWorkspaceMembershipId,
      metadata: { pmWorkspaceId, userId: input.userId },
    });
    return { ...row, userId: input.userId };
  }

  async removeMember(
    orgId: string,
    actorUserId: string,
    pmWorkspaceId: string,
    pmWorkspaceMembershipId: string,
  ): Promise<{ success: true }> {
    await this.assertWorkspaceExists(orgId, pmWorkspaceId);
    await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          role: pmWorkspaceMemberships.role,
        })
        .from(pmWorkspaceMemberships)
        .where(
          and(
            eq(pmWorkspaceMemberships.pmWorkspaceMembershipId, pmWorkspaceMembershipId),
            eq(pmWorkspaceMemberships.orgId, orgId),
            eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
          ),
        )
        .limit(1);
      if (!target) throw new NotFoundException("Workspace member not found");

      if (target.role === "admin") {
        await this.assertNotLastAdmin(
          tx,
          orgId,
          pmWorkspaceId,
          "Cannot remove the last admin of this workspace",
        );
      }

      await tx
        .delete(pmWorkspaceMemberships)
        .where(
          and(
            eq(pmWorkspaceMemberships.pmWorkspaceMembershipId, pmWorkspaceMembershipId),
            eq(pmWorkspaceMemberships.orgId, orgId),
            eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
          ),
        );

      await bumpPermissionsVersion(tx, orgId);
    });

    this.audit.log({
      action: "pm_workspace.member.removed",
      userId: actorUserId,
      orgId,
      resourceType: "pm_workspace_membership",
      resourceId: pmWorkspaceMembershipId,
      metadata: { pmWorkspaceId },
    });
    return { success: true };
  }

  async updateMemberRole(
    orgId: string,
    actorUserId: string,
    pmWorkspaceId: string,
    pmWorkspaceMembershipId: string,
    input: UpdateMemberRoleInput,
    actorMembershipId: number | null,
  ) {
    await this.assertWorkspaceExists(orgId, pmWorkspaceId);
    const result = await this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({
          organizationMembershipId: pmWorkspaceMemberships.organizationMembershipId,
          role: pmWorkspaceMemberships.role,
          userId: organizationMembers.userId,
        })
        .from(pmWorkspaceMemberships)
        .innerJoin(
          organizationMembers,
          eq(pmWorkspaceMemberships.organizationMembershipId, organizationMembers.id),
        )
        .where(
          and(
            eq(pmWorkspaceMemberships.pmWorkspaceMembershipId, pmWorkspaceMembershipId),
            eq(pmWorkspaceMemberships.orgId, orgId),
            eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
          ),
        )
        .limit(1);
      if (!target) throw new NotFoundException("Workspace member not found");

      if (
        input.role === "admin" &&
        actorMembershipId !== null &&
        target.organizationMembershipId === actorMembershipId
      ) {
        throw new ForbiddenException("Cannot escalate your own workspace role");
      }

      if (target.role === "admin" && input.role === "member") {
        await this.assertNotLastAdmin(
          tx,
          orgId,
          pmWorkspaceId,
          "Cannot demote the last admin of this workspace",
        );
      }

      const [updated] = await tx
        .update(pmWorkspaceMemberships)
        .set({ role: input.role })
        .where(
          and(
            eq(pmWorkspaceMemberships.pmWorkspaceMembershipId, pmWorkspaceMembershipId),
            eq(pmWorkspaceMemberships.orgId, orgId),
            eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
          ),
        )
        .returning();
      if (!updated) throw new NotFoundException("Workspace member not found");

      await bumpPermissionsVersion(tx, orgId);
      return { updated, userId: target.userId };
    });

    this.audit.log({
      action: "pm_workspace.member.role_updated",
      userId: actorUserId,
      orgId,
      resourceType: "pm_workspace_membership",
      resourceId: pmWorkspaceMembershipId,
      metadata: { pmWorkspaceId, newRole: input.role },
    });
    return { ...result.updated, userId: result.userId };
  }
}
