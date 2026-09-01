import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { portalMemberships } from "../../../db/schema/portal-access/portal-memberships";
import { projectClientGrants } from "../../../db/schema/portal-access/project-client-grants";
import { partyContacts, projects } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { type PgUpdateSetSource } from "drizzle-orm/pg-core";
import { AuditService } from "../../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeUuid } from "../../../common/pagination/keyset";
import type {
  ListMembershipsQuery,
  CreateMembershipInput,
  UpdateMembershipStatusInput,
  ListGrantsQuery,
  CreateGrantInput,
  UpdateGrantInput,
} from "./dto/portal-access.schemas";

const PG_UNIQUE_VIOLATION = "23505";

type MembershipRow = typeof portalMemberships.$inferSelect;
type GrantRow = typeof projectClientGrants.$inferSelect;
type GrantPatch = Partial<typeof projectClientGrants.$inferInsert>;

@Injectable()
export class PortalAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private async loadMembership(organizationId: string, portalMembershipId: string): Promise<MembershipRow> {
    const [row] = await this.db
      .select()
      .from(portalMemberships)
      .where(
        and(
          eq(portalMemberships.portalMembershipId, portalMembershipId),
          eq(portalMemberships.organizationId, organizationId),
          isNull(portalMemberships.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Portal membership not found");
    return row;
  }

  private async loadGrant(organizationId: string, projectClientGrantId: string): Promise<GrantRow> {
    const [row] = await this.db
      .select()
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.projectClientGrantId, projectClientGrantId),
          eq(projectClientGrants.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Project client grant not found");
    return row;
  }

  async listMemberships(organizationId: string, query: ListMembershipsQuery) {
    const { limit, cursor, status } = query;
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && !position) throw new BadRequestException("Invalid pagination cursor");

    const conditions = and(
      eq(portalMemberships.organizationId, organizationId),
      isNull(portalMemberships.deletedAt),
      status ? eq(portalMemberships.status, status) : undefined,
      position ? keysetBeforeUuid(portalMemberships.createdAt, portalMemberships.portalMembershipId, position) : undefined,
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          portalMembershipId: portalMemberships.portalMembershipId,
          organizationId: portalMemberships.organizationId,
          audience: portalMemberships.audience,
          partyContactId: portalMemberships.partyContactId,
          userMembershipId: portalMemberships.userMembershipId,
          status: portalMemberships.status,
          sessionEpoch: portalMemberships.sessionEpoch,
          deletedAt: portalMemberships.deletedAt,
          createdAt: portalMemberships.createdAt,
          updatedAt: portalMemberships.updatedAt,
          contactFirstName: partyContacts.firstName,
          contactLastName: partyContacts.lastName,
        })
        .from(portalMemberships)
        .leftJoin(
          partyContacts,
          and(
            eq(partyContacts.partyContactId, portalMemberships.partyContactId),
            eq(partyContacts.organizationId, portalMemberships.organizationId),
            isNull(partyContacts.deletedAt),
          ),
        )
        .where(conditions)
        .orderBy(desc(portalMemberships.createdAt), desc(portalMemberships.portalMembershipId))
        .limit(limit + 1),
    ]);
    return buildCursorPage(rows, limit, (row) => ({ sortValue: row.createdAt, id: row.portalMembershipId }));
  }

  async getMembership(organizationId: string, portalMembershipId: string) {
    return this.loadMembership(organizationId, portalMembershipId);
  }

  async createMembership(organizationId: string, userId: string, input: CreateMembershipInput) {
    const [contact] = await this.db
      .select({ partyContactId: partyContacts.partyContactId })
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.partyContactId, input.partyContactId),
          eq(partyContacts.organizationId, organizationId),
          isNull(partyContacts.deletedAt),
        ),
      )
      .limit(1);
    if (!contact) {
      throw new NotFoundException("Party contact not found in this organization");
    }

    const [row] = await this.db
      .insert(portalMemberships)
      .values({
        organizationId,
        partyContactId: input.partyContactId,
        userMembershipId: input.userMembershipId ?? null,
        status: "PENDING",
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException("Contact already has portal access in this organization.");
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create portal membership");
    this.audit.log({
      action: "portal_access.membership.created",
      userId,
      orgId: organizationId,
      resourceType: "portal_membership",
      resourceId: row.portalMembershipId,
      metadata: { portalMembershipId: row.portalMembershipId, partyContactId: row.partyContactId },
    });
    return row;
  }

  async setMembershipStatus(
    organizationId: string,
    userId: string,
    portalMembershipId: string,
    input: UpdateMembershipStatusInput,
  ) {
    await this.loadMembership(organizationId, portalMembershipId);

    const patch: PgUpdateSetSource<typeof portalMemberships> = {
      status: input.status,
    };

    if (input.status === "SUSPENDED" || input.status === "REVOKED") {
      patch.sessionEpoch = sql`${portalMemberships.sessionEpoch} + 1`;
    }

    const [updated] = await this.db
      .update(portalMemberships)
      .set(patch)
      .where(
        and(
          eq(portalMemberships.portalMembershipId, portalMembershipId),
          eq(portalMemberships.organizationId, organizationId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Portal membership not found");
    this.audit.log({
      action: "portal_access.membership.status_changed",
      userId,
      orgId: organizationId,
      resourceType: "portal_membership",
      resourceId: portalMembershipId,
      metadata: { portalMembershipId, status: input.status },
    });
    return updated;
  }

  async listGrants(organizationId: string, query: ListGrantsQuery) {
    const { limit, cursor, projectId } = query;
    const position = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && !position) throw new BadRequestException("Invalid pagination cursor");

    const conditions = and(
      eq(projectClientGrants.organizationId, organizationId),
      projectId ? eq(projectClientGrants.projectId, projectId) : undefined,
      position ? keysetBeforeUuid(projectClientGrants.createdAt, projectClientGrants.projectClientGrantId, position) : undefined,
    );

    const [rows, [totalRow]] = await Promise.all([
      this.db
        .select({
          projectClientGrantId: projectClientGrants.projectClientGrantId,
          organizationId: projectClientGrants.organizationId,
          portalMembershipId: projectClientGrants.portalMembershipId,
          partyContactId: projectClientGrants.partyContactId,
          projectId: projectClientGrants.projectId,
          pmWorkspaceId: projectClientGrants.pmWorkspaceId,
          canViewMilestones: projectClientGrants.canViewMilestones,
          canViewTasks: projectClientGrants.canViewTasks,
          canViewAttachments: projectClientGrants.canViewAttachments,
          canViewComments: projectClientGrants.canViewComments,
          canSubmitChangeRequests: projectClientGrants.canSubmitChangeRequests,
          status: projectClientGrants.status,
          expiresAt: projectClientGrants.expiresAt,
          createdAt: projectClientGrants.createdAt,
          updatedAt: projectClientGrants.updatedAt,
          contactFirstName: partyContacts.firstName,
          contactLastName: partyContacts.lastName,
        })
        .from(projectClientGrants)
        .leftJoin(
          partyContacts,
          and(
            eq(partyContacts.partyContactId, projectClientGrants.partyContactId),
            eq(partyContacts.organizationId, projectClientGrants.organizationId),
            isNull(partyContacts.deletedAt),
          ),
        )
        .where(conditions)
        .orderBy(desc(projectClientGrants.createdAt), desc(projectClientGrants.projectClientGrantId))
        .limit(limit + 1),
    ]);
    return buildCursorPage(rows, limit, (row) => ({ sortValue: row.createdAt, id: row.projectClientGrantId }));
  }

  async getGrant(organizationId: string, projectClientGrantId: string) {
    return this.loadGrant(organizationId, projectClientGrantId);
  }

  async createGrant(organizationId: string, userId: string, input: CreateGrantInput) {
    const membership = await this.loadMembership(organizationId, input.portalMembershipId);
    if (membership.status !== "ACTIVE") {
      throw new ForbiddenException("Portal membership is not active");
    }

    const [project] = await this.db
      .select({ id: projects.id, pmWorkspaceId: projects.pmWorkspaceId })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.orgId, organizationId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const resolvedWorkspaceId = input.pmWorkspaceId ?? project.pmWorkspaceId ?? null;
    if (
      input.pmWorkspaceId &&
      project.pmWorkspaceId &&
      input.pmWorkspaceId !== project.pmWorkspaceId
    ) {
      throw new ForbiddenException("Project does not belong to the specified PM workspace");
    }

    const [row] = await this.db
      .insert(projectClientGrants)
      .values({
        organizationId,
        portalMembershipId: input.portalMembershipId,
        partyContactId: membership.partyContactId,
        projectId: input.projectId,
        pmWorkspaceId: resolvedWorkspaceId,
        canViewMilestones: input.canViewMilestones ?? false,
        canViewTasks: input.canViewTasks ?? false,
        canViewAttachments: input.canViewAttachments ?? false,
        canViewComments: input.canViewComments ?? false,
        canSubmitChangeRequests: input.canSubmitChangeRequests ?? false,
        status: "ACTIVE",
      })
      .returning()
      .catch((err: unknown) => {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === PG_UNIQUE_VIOLATION
        ) {
          throw new ConflictException("A grant already exists for this membership and project.");
        }
        throw err;
      });
    if (!row) throw new NotFoundException("Failed to create project client grant");
    this.audit.log({
      action: "portal_access.grant.created",
      userId,
      orgId: organizationId,
      resourceType: "project_client_grant",
      resourceId: row.projectClientGrantId,
      metadata: {
        projectClientGrantId: row.projectClientGrantId,
        portalMembershipId: row.portalMembershipId,
        projectId: row.projectId,
      },
    });
    return row;
  }

  async updateGrant(
    organizationId: string,
    userId: string,
    projectClientGrantId: string,
    input: UpdateGrantInput,
  ) {
    await this.loadGrant(organizationId, projectClientGrantId);

    const patch: GrantPatch = {};
    if (input.canViewMilestones !== undefined) patch.canViewMilestones = input.canViewMilestones;
    if (input.canViewTasks !== undefined) patch.canViewTasks = input.canViewTasks;
    if (input.canViewAttachments !== undefined) patch.canViewAttachments = input.canViewAttachments;
    if (input.canViewComments !== undefined) patch.canViewComments = input.canViewComments;
    if (input.canSubmitChangeRequests !== undefined) patch.canSubmitChangeRequests = input.canSubmitChangeRequests;
    if (input.status !== undefined) patch.status = input.status;
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    const [updated] = await this.db
      .update(projectClientGrants)
      .set(patch)
      .where(
        and(
          eq(projectClientGrants.projectClientGrantId, projectClientGrantId),
          eq(projectClientGrants.organizationId, organizationId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Project client grant not found");
    this.audit.log({
      action: "portal_access.grant.updated",
      userId,
      orgId: organizationId,
      resourceType: "project_client_grant",
      resourceId: projectClientGrantId,
      metadata: { projectClientGrantId },
    });
    return updated;
  }

  async revokeGrant(organizationId: string, userId: string, projectClientGrantId: string) {
    await this.loadGrant(organizationId, projectClientGrantId);

    const [updated] = await this.db
      .update(projectClientGrants)
      .set({ status: "REVOKED" })
      .where(
        and(
          eq(projectClientGrants.projectClientGrantId, projectClientGrantId),
          eq(projectClientGrants.organizationId, organizationId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Project client grant not found");
    this.audit.log({
      action: "portal_access.grant.revoked",
      userId,
      orgId: organizationId,
      resourceType: "project_client_grant",
      resourceId: projectClientGrantId,
      metadata: { projectClientGrantId },
    });
    return updated;
  }
}
