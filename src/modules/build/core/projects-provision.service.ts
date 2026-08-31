import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { deals, projectMembers, projects, projectStatuses } from "../../../db/schema";
import { DEFAULT_PROJECT_STATUSES } from "./lib/default-statuses";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import type { CreateProjectInput, FromDealInput } from "./dto/projects.schemas";
import { PmWorkspacesService } from "../pm-workspaces/pm-workspaces.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";


function generateProjectKey(name: string): string {
  const namePart = name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
  const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

@Injectable()
export class ProjectsProvisionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly planLimits: PlanLimitsService,
    private readonly dispatch: NotificationDispatchService,
    private readonly pmWorkspaces: PmWorkspacesService,
  ) {}

  async createProject(orgId: string, creatorUserId: string, input: CreateProjectInput) {
    const projectKey = input.key ?? generateProjectKey(input.name);

    await this.planLimits.assertWithinLimit(orgId, "projects");

    const pmWorkspaceId = await this.pmWorkspaces.resolveDefaultWorkspaceId(orgId);

    const project = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          orgId,
          pmWorkspaceId,
          key: projectKey,
          name: input.name,
          description: input.description,
          managerId: input.managerId ?? creatorUserId,
          clientId: input.clientId,
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

      const additionalMembers = (input.memberIds ?? []).filter((id) => id !== creatorUserId);
      const memberRows = [
        { orgId, projectId: created.id, userId: creatorUserId, role: "OWNER" as const },
        ...additionalMembers.map((userId) => ({
          orgId,
          projectId: created.id,
          userId,
          role: "CONTRIBUTOR" as const,
        })),
      ];
      await tx.insert(projectMembers).values(memberRows);

      return created;
    }).catch((err: unknown) => {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(`A project with key "${projectKey}" already exists in this organization.`);
      }
      throw err;
    });

    const additionalMembers = (input.memberIds ?? []).filter((id) => id !== creatorUserId);
    if (additionalMembers.length > 0) {
      await this.dispatch.emit({
        eventKey: "build.project.member_added",
        orgId,
        actorUserId: creatorUserId,
        targetUserIds: additionalMembers,
        entityType: "project",
        entityId: String(project.id),
        title: "You were added to a project",
        message: `You were added to project "${input.name}" (${projectKey}).`,
        link: `/projects/${project.id}`,
        variables: { projectName: input.name, projectKey, projectId: project.id },
      }).catch(logSideEffectFailure("project member notification", { orgId }));
    }

    this.audit.log({
      action: "project.created",
      userId: creatorUserId,
      orgId,
      targetId: String(project.id),
      targetType: "project",
      metadata: { name: input.name, key: projectKey, managerId: input.managerId },
    });

    await this.cache.invalidateNamespace(`projects:list:${orgId}`);

    return project;
  }

  async createFromDeal(orgId: string, userId: string, input: FromDealInput) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, input.dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
    });
    if (!deal) throw new NotFoundException("Deal not found");

    await this.planLimits.assertWithinLimit(orgId, "projects");

    const pmWorkspaceId = await this.pmWorkspaces.resolveDefaultWorkspaceId(orgId);

    const namePart = input.name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const projectKey = (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;

    const project = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          orgId,
          pmWorkspaceId,
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
          managerId: deal.assignedToId ?? userId,
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

      await tx.insert(projectMembers).values({ orgId, projectId: created.id, userId, role: "OWNER" });

      return created;
    }).catch((err: unknown) => {
      if (isDuplicateKeyError(err)) {
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
