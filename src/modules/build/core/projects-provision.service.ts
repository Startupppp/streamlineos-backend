import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  deals,
  managedProducts,
  projectMembers,
  projects,
  projectStatuses,
} from "../../../db/schema";
import { resolveOrganizationActorsByUserIds } from "../../../common/organization/organization-actor";
import { DEFAULT_PROJECT_STATUSES } from "./lib/default-statuses";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CreateProjectInput, FromDealInput } from "./dto/projects.schemas";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { lockQuota } from "../../billing/core/seat-definition";
import { buildProjectHref } from "./build-app-paths";

function generateProjectKey(name: string): string {
  const namePart = name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
  const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;
}

@Injectable()
export class ProjectsProvisionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  private async resolveManagedProductInOrg(
    orgId: string,
    managedProductId: number | undefined,
  ): Promise<number | null> {
    if (managedProductId === undefined) return null;
    const [product] = await this.db
      .select({ id: managedProducts.id })
      .from(managedProducts)
      .where(
        and(
          eq(managedProducts.id, managedProductId),
          eq(managedProducts.orgId, orgId),
          isNull(managedProducts.deletedAt),
        ),
      )
      .limit(1);
    if (!product) throw new NotFoundException("Managed product not found");
    return managedProductId;
  }

  async createProject(orgId: string, creatorUserId: string, input: CreateProjectInput) {
    const projectKey = input.key ?? generateProjectKey(input.name);

    const managedProductId = await this.resolveManagedProductInOrg(
      orgId,
      input.managedProductId,
    );
    const additionalMembers = (input.memberIds ?? []).filter((id) => id !== creatorUserId);
    const requestedManagerId = input.managerId ?? creatorUserId;
    const actors = await resolveOrganizationActorsByUserIds(this.db, orgId, [
      creatorUserId,
      requestedManagerId,
      ...additionalMembers,
      ...(input.clientId !== undefined ? [input.clientId] : []),
    ]);
    const creator = actors.get(creatorUserId);
    const manager = actors.get(requestedManagerId);
    if (!creator || !manager || additionalMembers.some((id) => !actors.has(id)))
      throw new NotFoundException("Project actors must be active members of this organization");

    const project = await this.db.transaction(async (tx) => {
      await tx.execute(lockQuota(orgId, "projects"));
      await this.planLimits.assertWithinLimit(orgId, "projects", 1, tx);

      const [created] = await tx
        .insert(projects)
        .values({
          orgId,
          managedProductId,
          key: projectKey,
          name: input.name,
          description: input.description,
          managerMembershipId: manager.membershipId,
          clientMembershipId: input.clientId !== undefined ? (actors.get(input.clientId)?.membershipId ?? null) : undefined,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          endDate: input.endDate ? new Date(input.endDate) : undefined,
          status: "ACTIVE",
          priority: input.priority ?? null,
          settings: {
            modules: input.modules ?? { sprints: true, epics: true, timeTracking: true, wiki: true },
            ...(input.projectType !== undefined ? { projectType: input.projectType } : {}),
            ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
            ...(input.features !== undefined ? { features: input.features } : {}),
          },
        })
        .returning();

      await tx.insert(projectStatuses).values(
        DEFAULT_PROJECT_STATUSES.map((s) => ({
          orgId,
          projectId: created.id,
          name: s.name,
          order: s.order,
          color: s.color,
          type: s.type,
        })),
      );

      const memberRows = [
        { orgId, projectId: created.id, membershipId: creator.membershipId, role: "OWNER" as const },
        ...additionalMembers.map((userId) => ({
          orgId,
          projectId: created.id,
          membershipId: actors.get(userId)!.membershipId,
          role: "CONTRIBUTOR" as const,
        })),
      ];
      await tx.insert(projectMembers).values(memberRows);

      return created;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A project with key "${projectKey}" already exists in this organization.`);
      }
      throw err;
    });

    const notificationMembers = (input.memberIds ?? []).filter((id) => id !== creatorUserId);
    if (notificationMembers.length > 0) {
      await this.dispatch.emit({
        eventKey: "build.project.member_added",
        orgId,
        actorUserId: creatorUserId,
        targetUserIds: notificationMembers,
        entityType: "project",
        entityId: String(project.id),
        title: "You were added to a project",
        message: `You were added to project "${input.name}" (${projectKey}).`,
        link: buildProjectHref(project.id),
        variables: { projectName: input.name, projectKey, projectId: project.id },
      }).catch(logSideEffectFailure("project member notification", { orgId }));
    }

    this.audit.log({
      action: "project.created",
      userId: creatorUserId,
      orgId,
      targetId: String(project.id),
      targetType: "project",
      metadata: { name: input.name, key: projectKey, managerMembershipId: manager.membershipId },
    });

    return project;
  }

  async createFromDeal(orgId: string, userId: string, input: FromDealInput) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, input.dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
    });
    if (!deal) throw new NotFoundException("Deal not found");

    const actors = await resolveOrganizationActorsByUserIds(this.db, orgId, [userId, ...(deal.assignedToId ? [deal.assignedToId] : [])]);
    const creator = actors.get(userId);
    const manager = actors.get(deal.assignedToId ?? userId);
    if (!creator || !manager)
      throw new NotFoundException("Project actors must be active members of this organization");

    const namePart = input.name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const projectKey = (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;

    const project = await this.db.transaction(async (tx) => {
      await tx.execute(lockQuota(orgId, "projects"));
      await this.planLimits.assertWithinLimit(orgId, "projects", 1, tx);

      const [created] = await tx
        .insert(projects)
        .values({
          orgId,
          key: projectKey,
          name: input.name,
          description: input.description ?? deal.notes ?? null,
          startDate: input.startDate ? new Date(input.startDate) : new Date(),
          endDate: input.endDate
            ? new Date(input.endDate)
            : deal.expectedCloseDate
              ? new Date(deal.expectedCloseDate)
              : undefined,
          status: "ACTIVE",
          dealId: input.dealId,
          managerMembershipId: manager.membershipId,
          budget: deal.value ?? undefined,
          budgetMinor: deal.value === null ? null : Math.round(Number(deal.value) * 100),
          settings: { modules: { sprints: true, epics: true, timeTracking: true, wiki: true } },
        })
        .returning();

      await tx.insert(projectStatuses).values(
        DEFAULT_PROJECT_STATUSES.map((s) => ({
          orgId,
          projectId: created.id,
          name: s.name,
          order: s.order,
          color: s.color,
          type: s.type,
        })),
      );

      await tx.insert(projectMembers).values({ orgId, projectId: created.id, membershipId: creator.membershipId, role: "OWNER" });

      return created;
    }).catch((err: unknown) => {
      if (isUniqueViolation(err)) {
        throw new ConflictException(`A project with key "${projectKey}" already exists in this organization.`);
      }
      throw err;
    });

    this.audit.log({
      action: "project.created_from_deal",
      userId,
      orgId,
      targetId: String(project.id),
      targetType: "project",
      metadata: { dealId: input.dealId, dealName: deal.name, projectKey },
    });

    return project;
  }
}
