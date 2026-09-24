import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, isNull } from "drizzle-orm";
import {
  projectMembers,
  projects,
  projectStatuses,
  projectTemplates,
  projectTemplateTickets,
  ticketPriorityEnum,
  tickets,
  ticketTypeEnum,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import type {
  ApplyTemplateInput,
  CreateTemplateInput,
} from "./dto/projects.schemas";
import { DEFAULT_PROJECT_STATUSES } from "./lib/default-statuses";
import { resolveOrganizationActorsByUserIds } from "../../../common/organization/organization-actor";


function normalizeTicketType(
  raw: string | null | undefined,
): (typeof ticketTypeEnum.enumValues)[number] {
  const upper = (raw ?? "TASK").toUpperCase();
  return ticketTypeEnum.enumValues.find((v) => v === upper) ?? "TASK";
}

function normalizeTicketPriority(
  raw: string | null | undefined,
): (typeof ticketPriorityEnum.enumValues)[number] {
  const upper = (raw ?? "MEDIUM").toUpperCase();
  return ticketPriorityEnum.enumValues.find((v) => v === upper) ?? "MEDIUM";
}

@Injectable()
export class ProjectsTemplatesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly planLimits: PlanLimitsService,
  ) {}

  listTemplates(orgId: string) {
    return this.db.query.projectTemplates.findMany({
      where: and(eq(projectTemplates.orgId, orgId), isNull(projectTemplates.deletedAt)),
      with: {
        tickets: { orderBy: (t, { asc }) => [asc(t.order)], limit: 200 },
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      limit: 50,
    });
  }

  async createTemplate(
    orgId: string,
    userId: string,
    input: CreateTemplateInput,
  ) {
    const [template] = await this.db
      .insert(projectTemplates)
      .values({
        orgId,
        name: input.name,
        description: input.description,
        category: input.category,
        createdBy: userId,
      })
      .returning();

    if (!template)
      throw new InternalServerErrorException("Failed to create template");

    if (input.tickets.length > 0) {
      await this.db.insert(projectTemplateTickets).values(
        input.tickets.map((t, i) => ({
          orgId,
          templateId: template.id,
          title: t.title,
          description: t.description,
          type: t.type,
          priority: t.priority,
          estimatedHours: t.estimatedHours ? String(t.estimatedHours) : null,
          order: t.order ?? i,
          phase: t.phase,
        })),
      );
    }

    return this.db.query.projectTemplates.findFirst({
      where: eq(projectTemplates.id, template.id),
      with: {
        tickets: { orderBy: (t, { asc }) => [asc(t.order)], limit: 200 },
      },
    });
  }

  async deleteTemplate(orgId: string, templateId: number) {
    const [stamped] = await this.db
      .update(projectTemplates)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(projectTemplates.id, templateId),
          eq(projectTemplates.orgId, orgId),
          isNull(projectTemplates.deletedAt),
        ),
      )
      .returning({ id: projectTemplates.id });
    if (!stamped) throw new NotFoundException("Template not found");
    return { success: true };
  }

  async applyTemplate(
    orgId: string,
    userId: string,
    templateId: number,
    input: ApplyTemplateInput,
  ) {
    const template = await this.db.query.projectTemplates.findFirst({
      where: and(
        eq(projectTemplates.id, templateId),
        eq(projectTemplates.orgId, orgId),
        isNull(projectTemplates.deletedAt),
      ),
      with: { tickets: { orderBy: (t, { asc }) => [asc(t.order)] } },
    });
    if (!template) throw new NotFoundException("Template not found");

    await this.planLimits.assertWithinLimit(orgId, "projects");

    const requestedManagerId = input.managerId ?? userId;
    const actors = await resolveOrganizationActorsByUserIds(this.db, orgId, [userId, requestedManagerId]);
    const creator = actors.get(userId);
    const manager = actors.get(requestedManagerId);
    if (!creator || !manager)
      throw new NotFoundException("Project actors must be active members of this organization");

    const namePart = input.name
      .replace(/[^a-zA-Z]/g, "")
      .substring(0, 3)
      .toUpperCase();
    const randomPart = Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0");
    const key = (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;

    const [project] = await this.db
      .insert(projects)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? template.description ?? null,
        key,
        managerMembershipId: manager.membershipId,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      })
      .returning();

    if (!project)
      throw new InternalServerErrorException("Failed to create project");

    await this.db
      .insert(projectMembers)
      .values({ orgId, projectId: project.id, membershipId: creator.membershipId, role: "OWNER" });

    await this.db.insert(projectStatuses).values(
      DEFAULT_PROJECT_STATUSES.map((s) => ({
        ...s,
        orgId,
        projectId: project.id,
      })),
    );

    if (template.tickets.length > 0) {
      const [{ value: maxTN }] = await this.db
        .select({ value: count(tickets.id) })
        .from(tickets)
        .where(eq(tickets.projectId, project.id));

      await this.db.insert(tickets).values(
        template.tickets.map((t, i) => ({
          orgId,
          projectId: project.id,
          title: t.title,
          description: t.description ?? null,
          type: normalizeTicketType(t.type),
          status: "TODO",
          priority: normalizeTicketPriority(t.priority),
          ticketNumber: Number(maxTN) + i + 1,
          rank: String(((t.order ?? i) + 1) * 1000),
          originalEstimate: t.estimatedHours ? String(t.estimatedHours) : null,
          reporterId: userId,
        })),
      );
    }

    return {
      projectId: project.id,
      key: project.key,
      ticketsCreated: template.tickets.length,
    };
  }
}
