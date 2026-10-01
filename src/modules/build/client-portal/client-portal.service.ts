import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  changeRequests,
  portalMemberships,
  projectClientGrants,
  projects,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import type { CreatePortalCrInput } from "./dto/client-portal.schemas";
import { assertProjectAccess, assertProjectWriteAccess } from "../core";
import { nextChangeRequestNumber } from "./change-request-number-counter";
import { buildPortalProjection } from "./portal-projection";
import type { PortalCapabilities } from "./portal-projection";

const INACTIVE_CAPABILITIES: PortalCapabilities = {
  canViewMilestones: false,
  canViewTasks: false,
  canViewAttachments: false,
  canViewComments: false,
};

@Injectable()
export class ClientPortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async createPortalChangeRequest(u: CurrentUserContext, projectId: number, input: CreatePortalCrInput) {
    await assertProjectWriteAccess(this.db, this.access, u, projectId);
    const [cr] = await this.db.transaction(async (tx) => {
      const nextNumber = await nextChangeRequestNumber(tx, u.orgId, projectId);
      return tx
        .insert(changeRequests)
        .values({
          orgId: u.orgId,
          projectId,
          crNumber: nextNumber,
          title: input.title,
          description: input.description,
          impact: input.impact,
          estimateMinutes: input.estimateMinutes,
          budgetImpactCents: input.budgetImpactCents,
          timelineImpactDays: input.timelineImpactDays,
          status: "submitted",
          requestedById: u.userId,
          createdBy: u.userId,
        })
        .returning({
          id: changeRequests.id,
          crNumber: changeRequests.crNumber,
          title: changeRequests.title,
          description: changeRequests.description,
          impact: changeRequests.impact,
          status: changeRequests.status,
          estimateMinutes: changeRequests.estimateMinutes,
          budgetImpactCents: changeRequests.budgetImpactCents,
          timelineImpactDays: changeRequests.timelineImpactDays,
          decisionComment: changeRequests.decisionComment,
          createdAt: changeRequests.createdAt,
        });
    });
    this.audit.log({
      action: "change_request.created",
      userId: u.userId,
      orgId: u.orgId,
      resourceType: "change_request",
      resourceId: String(cr.id),
      metadata: { crId: cr.id, projectId, crNumber: cr.crNumber, title: cr.title, source: "portal" },
    });
    return cr;
  }

  private async portalMembershipIdsFor(orgId: string, membershipId: number) {
    const rows = await this.db
      .select({ id: portalMemberships.portalMembershipId })
      .from(portalMemberships)
      .where(
        and(
          eq(portalMemberships.organizationId, orgId),
          eq(portalMemberships.userMembershipId, membershipId),
        ),
      )
      .limit(50);
    return rows.map((r) => r.id);
  }

  async listPortalProjects(orgId: string, membershipId: number) {
    const portalMembershipIds = await this.portalMembershipIdsFor(orgId, membershipId);
    if (portalMembershipIds.length === 0) return [];

    const now = new Date();
    const grants = await this.db
      .select({ projectId: projectClientGrants.projectId })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, orgId),
          inArray(projectClientGrants.portalMembershipId, portalMembershipIds),
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
      .where(
        and(eq(projects.orgId, orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)),
      )
      .limit(100);
  }

  private async resolveActiveGrant(orgId: string, projectId: number) {
    const now = new Date();
    const [grantRow] = await this.db
      .select({
        canViewMilestones: projectClientGrants.canViewMilestones,
        canViewTasks: projectClientGrants.canViewTasks,
        canViewAttachments: projectClientGrants.canViewAttachments,
        canViewComments: projectClientGrants.canViewComments,
      })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, orgId),
          eq(projectClientGrants.projectId, projectId),
          eq(projectClientGrants.status, "ACTIVE"),
          or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, now)),
        ),
      )
      .orderBy(desc(projectClientGrants.createdAt))
      .limit(1);
    return grantRow ?? null;
  }

  async getProjectOverview(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);

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
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const capabilities = (await this.resolveActiveGrant(u.orgId, projectId)) ?? INACTIVE_CAPABILITIES;
    const data = await buildPortalProjection(this.db, u.orgId, projectId, capabilities);
    return { project, ...data };
  }

  async getPortalPreview(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);

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
      .where(and(eq(projects.id, projectId), eq(projects.orgId, u.orgId), isNull(projects.deletedAt)))
      .limit(1);
    if (!project) throw new NotFoundException("Project not found");

    const grant = await this.resolveActiveGrant(u.orgId, projectId);
    if (!grant) throw new NotFoundException("No active portal grant for this project");
    const data = await buildPortalProjection(this.db, u.orgId, projectId, grant);
    return { project, ...data };
  }

  async listPortalChangeRequests(u: CurrentUserContext, projectId: number) {
    const membershipId = actingMembershipId(u.principal);
    if (membershipId === null) throw new NotFoundException("Project not found");
    const portalMembershipIds = await this.portalMembershipIdsFor(u.orgId, membershipId);
    if (portalMembershipIds.length === 0) throw new NotFoundException("Project not found");
    const now = new Date();
    const [grant] = await this.db
      .select({ projectId: projectClientGrants.projectId })
      .from(projectClientGrants)
      .where(
        and(
          eq(projectClientGrants.organizationId, u.orgId),
          eq(projectClientGrants.projectId, projectId),
          inArray(projectClientGrants.portalMembershipId, portalMembershipIds),
          eq(projectClientGrants.status, "ACTIVE"),
          or(isNull(projectClientGrants.expiresAt), gt(projectClientGrants.expiresAt, now)),
        ),
      )
      .limit(1);
    if (!grant) throw new NotFoundException("Project not found");
    return this.db
      .select({
        id: changeRequests.id,
        crNumber: changeRequests.crNumber,
        title: changeRequests.title,
        description: changeRequests.description,
        impact: changeRequests.impact,
        status: changeRequests.status,
        estimateMinutes: changeRequests.estimateMinutes,
        budgetImpactCents: changeRequests.budgetImpactCents,
        timelineImpactDays: changeRequests.timelineImpactDays,
        decisionComment: changeRequests.decisionComment,
        createdAt: changeRequests.createdAt,
      })
      .from(changeRequests)
      .where(
        and(
          eq(changeRequests.orgId, u.orgId),
          eq(changeRequests.projectId, projectId),
          isNull(changeRequests.deletedAt),
        ),
      )
      .limit(100);
  }
}
