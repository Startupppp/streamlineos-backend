import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  changeRequests,
  organizationMembers,
  projectClientGrants,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PortalProjectionService } from "../../build/client-portal/portal-projection.service";
import type { SubmitChangeRequestInput } from "./dto/portal-client.schemas";

type GrantRow = typeof projectClientGrants.$inferSelect;

@Injectable()
export class PortalClientService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly portalProjection: PortalProjectionService,
  ) {}

  private activeGrantWhere(orgId: string, membershipId: string, projectId: number) {
    return and(
      eq(projectClientGrants.organizationId, orgId),
      eq(projectClientGrants.portalMembershipId, membershipId),
      eq(projectClientGrants.projectId, projectId),
      eq(projectClientGrants.status, "ACTIVE"),
      or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, new Date())),
    );
  }

  private async loadActiveGrant(
    orgId: string,
    membershipId: string,
    projectId: number,
  ): Promise<GrantRow> {
    const [grant] = await this.db
      .select()
      .from(projectClientGrants)
      .where(this.activeGrantWhere(orgId, membershipId, projectId))
      .limit(1);
    if (!grant) throw new NotFoundException("Project not found");
    return grant;
  }

  private async resolveSubmitterUserId(
    orgId: string,
    portalUserMembershipId: number | null,
  ): Promise<string | null> {
    if (portalUserMembershipId === null) return null;
    const [member] = await this.db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.id, portalUserMembershipId),
          eq(organizationMembers.orgId, orgId),
        ),
      )
      .limit(1);
    return member?.userId ?? null;
  }

  async listGrantedProjects(orgId: string, membershipId: string) {
    const now = new Date();
    const grants = await this.db
      .select({ projectId: projectClientGrants.projectId })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, orgId),
          eq(projectClientGrants.portalMembershipId, membershipId),
          eq(projectClientGrants.status, "ACTIVE"),
          or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, now)),
        ),
      )
      .limit(100);

    if (grants.length === 0) return [];

    const projectIds = grants.map((g) => g.projectId);

    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        startDate: projects.startDate,
        targetEndDate: projects.endDate,
      })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)))
      .limit(100);
  }

  async getProjectOverview(orgId: string, membershipId: string, projectId: number) {
    const grant = await this.loadActiveGrant(orgId, membershipId, projectId);

    const [project] = await this.db
      .select({
        id: projects.id,
        name: projects.name,
        key: projects.key,
        status: projects.status,
        startDate: projects.startDate,
        targetEndDate: projects.endDate,
      })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId), isNull(projects.deletedAt)))
      .limit(1);

    if (!project) throw new NotFoundException("Project not found");

    const { milestones, tasks: projectTasks, attachments, comments } =
      await this.portalProjection.build(orgId, projectId, grant);

    return {
      project,
      milestones,
      tasks: projectTasks,
      attachments,
      comments,
      capabilities: {
        canViewMilestones: grant.canViewMilestones,
        canViewTasks: grant.canViewTasks,
        canViewAttachments: grant.canViewAttachments,
        canViewComments: grant.canViewComments,
        canSubmitChangeRequests: grant.canSubmitChangeRequests,
      },
    };
  }

  async submitChangeRequest(
    orgId: string,
    membershipId: string,
    portalUserMembershipId: number | null,
    projectId: number,
    input: SubmitChangeRequestInput,
  ) {
    const submitterUserId = await this.resolveSubmitterUserId(orgId, portalUserMembershipId);

    return this.db.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(projectClientGrants)
        .where(this.activeGrantWhere(orgId, membershipId, projectId))
        .limit(1)
        .for("update");
      if (!grant) throw new NotFoundException("Project not found");
      if (!grant.canSubmitChangeRequests)
        throw new ForbiddenException("Change request submission not permitted for this project");

      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);

      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${changeRequests.crNumber}), 0)` })
        .from(changeRequests)
        .where(
          and(
            eq(changeRequests.projectId, projectId),
            eq(changeRequests.orgId, orgId),
          ),
        );

      const nextNumber = (maxRow?.maxNum ?? 0) + 1;

      const [cr] = await tx
        .insert(changeRequests)
        .values({
          orgId,
          projectId,
          crNumber: nextNumber,
          title: input.title,
          description: input.description,
          status: "submitted",
          requestedById: submitterUserId,
          createdBy: submitterUserId,
        })
        .returning({
          id: changeRequests.id,
          crNumber: changeRequests.crNumber,
          title: changeRequests.title,
          status: changeRequests.status,
          createdAt: changeRequests.createdAt,
        });

      await this.audit.logCritical({
        action: "portal.change_request_submitted",
        ...(submitterUserId ? { userId: submitterUserId } : { systemActor: "portal-change-request" }),
        orgId,
        resourceType: "change_request",
        resourceId: String(cr.id),
        metadata: {
          projectId,
          crNumber: cr.crNumber,
          portalMembershipId: membershipId,
          projectClientGrantId: grant.projectClientGrantId,
        },
      });

      return cr;
    });
  }
}
