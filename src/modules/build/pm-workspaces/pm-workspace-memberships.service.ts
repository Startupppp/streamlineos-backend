import {
  ConflictException,
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
import type {
  AddWorkspaceMemberInput,
  ListMembersQuery,
} from "./dto/pm-workspaces.schemas";

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === PG_UNIQUE_VIOLATION
  );
}

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
    userId: string,
    pmWorkspaceId: string,
    pmWorkspaceMembershipId: string,
  ): Promise<{ success: true }> {
    await this.assertWorkspaceExists(orgId, pmWorkspaceId);
    const [deleted] = await this.db
      .delete(pmWorkspaceMemberships)
      .where(
        and(
          eq(
            pmWorkspaceMemberships.pmWorkspaceMembershipId,
            pmWorkspaceMembershipId,
          ),
          eq(pmWorkspaceMemberships.orgId, orgId),
          eq(pmWorkspaceMemberships.pmWorkspaceId, pmWorkspaceId),
        ),
      )
      .returning();
    if (!deleted) throw new NotFoundException("Workspace member not found");
    this.audit.log({
      action: "pm_workspace.member.removed",
      userId,
      orgId,
      resourceType: "pm_workspace_membership",
      resourceId: pmWorkspaceMembershipId,
      metadata: { pmWorkspaceId },
    });
    return { success: true };
  }
}
