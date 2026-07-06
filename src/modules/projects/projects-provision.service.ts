import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { deals, projectMembers, projects, projectStatuses } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { ProjectsEmailService } from "./projects-email.service";
import type { CreateProjectInput, FromDealInput } from "./dto/projects.schemas";

const DEFAULT_STATUSES = [
  { name: "TODO", order: 0, color: "#e2e8f0" },
  { name: "IN_PROGRESS", order: 1, color: "#3b82f6" },
  { name: "IN_REVIEW", order: 2, color: "#eab308" },
  { name: "DONE", order: 3, color: "#22c55e" },
];

function generateProjectKey(name: string): string {
  const namePart = name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
  const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;
}

@Injectable()
export class ProjectsProvisionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly projectsEmail: ProjectsEmailService,
  ) {}

  async createProject(orgId: string, creatorUserId: string, input: CreateProjectInput) {
    const projectKey = input.key ?? generateProjectKey(input.name);

    const project = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          orgId,
          key: projectKey,
          name: input.name,
          description: input.description,
          managerId: input.managerId,
          clientId: input.clientId,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          endDate: input.endDate ? new Date(input.endDate) : undefined,
          status: "ACTIVE",
          settings: {
            modules: input.modules ?? { sprints: true, epics: true, timeTracking: true, wiki: true },
            ...(input.projectType !== undefined ? { projectType: input.projectType } : {}),
            ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
            ...(input.features !== undefined ? { features: input.features } : {}),
          },
        })
        .returning();

      await tx.insert(projectStatuses).values(
        DEFAULT_STATUSES.map((s) => ({
          orgId,
          projectId: created.id,
          name: s.name,
          order: s.order,
          color: s.color,
        })),
      );

      const additionalMembers = (input.memberIds ?? []).filter((id) => id !== creatorUserId);
      const memberRows = [
        { projectId: created.id, userId: creatorUserId, role: "OWNER" as const },
        ...additionalMembers.map((userId) => ({
          projectId: created.id,
          userId,
          role: "CONTRIBUTOR" as const,
        })),
      ];
      await tx.insert(projectMembers).values(memberRows);

      return created;
    });

    const additionalMembers = (input.memberIds ?? []).filter((id) => id !== creatorUserId);
    if (additionalMembers.length > 0) {
      void this.projectsEmail
        .notifyProjectMembers(creatorUserId, additionalMembers, input.name, projectKey, project.id)
        .catch(() => undefined);
    }

    this.audit.log({
      action: "project.created",
      userId: creatorUserId,
      orgId,
      targetId: String(project.id),
      targetType: "project",
      metadata: { name: input.name, key: projectKey, managerId: input.managerId },
    });

    await this.cache.invalidatePattern(`projects:list:${orgId}:*`);

    return project;
  }

  async createFromDeal(orgId: string, userId: string, input: FromDealInput) {
    const deal = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, input.dealId), eq(deals.orgId, orgId)),
    });
    if (!deal) throw new NotFoundException("Deal not found");

    const namePart = input.name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const projectKey = (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;

    const project = await this.db.transaction(async (tx) => {
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
          managerId: deal.assignedToId ?? userId,
          budget: deal.value ?? undefined,
          settings: { modules: { sprints: true, epics: true, timeTracking: true, wiki: true } },
        })
        .returning();

      await tx.insert(projectStatuses).values(
        DEFAULT_STATUSES.map((s) => ({
          orgId,
          projectId: created.id,
          name: s.name,
          order: s.order,
          color: s.color,
        })),
      );

      await tx.insert(projectMembers).values({ projectId: created.id, userId, role: "OWNER" });

      return created;
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
