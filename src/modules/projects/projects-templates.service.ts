import { Inject, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { and, count, eq } from "drizzle-orm";
import {
  projectMembers,
  projects,
  projectStatuses,
  projectTemplates,
  projectTemplateTickets,
  ticketPriorityEnum,
  tickets,
  ticketTypeEnum,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { ApplyTemplateInput, CreateTemplateInput } from "./dto/projects.schemas";

const APPLY_DEFAULT_STATUSES = [
  { name: "To Do", color: "#94a3b8", order: 0 },
  { name: "In Progress", color: "#3b82f6", order: 1 },
  { name: "Done", color: "#22c55e", order: 2 },
];

function normalizeTicketType(raw: string | null | undefined): (typeof ticketTypeEnum.enumValues)[number] {
  const upper = (raw ?? "TASK").toUpperCase();
  return ticketTypeEnum.enumValues.find((v) => v === upper) ?? "TASK";
}

function normalizeTicketPriority(raw: string | null | undefined): (typeof ticketPriorityEnum.enumValues)[number] {
  const upper = (raw ?? "MEDIUM").toUpperCase();
  return ticketPriorityEnum.enumValues.find((v) => v === upper) ?? "MEDIUM";
}

@Injectable()
export class ProjectsTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  listTemplates(orgId: string) {
    return this.db.query.projectTemplates.findMany({
      where: eq(projectTemplates.orgId, orgId),
      with: { tickets: { orderBy: (t, { asc }) => [asc(t.order)] } },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }

  async createTemplate(orgId: string, userId: string, input: CreateTemplateInput) {
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

    if (!template) throw new InternalServerErrorException("Failed to create template");

    if (input.tickets.length > 0) {
      await this.db.insert(projectTemplateTickets).values(
        input.tickets.map((t, i) => ({
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
      with: { tickets: { orderBy: (t, { asc }) => [asc(t.order)] } },
    });
  }

  async deleteTemplate(orgId: string, templateId: number) {
    const [deleted] = await this.db
      .delete(projectTemplates)
      .where(and(eq(projectTemplates.id, templateId), eq(projectTemplates.orgId, orgId)))
      .returning();
    if (!deleted) throw new NotFoundException("Template not found");
    return { success: true };
  }

  async applyTemplate(orgId: string, userId: string, templateId: number, input: ApplyTemplateInput) {
    const template = await this.db.query.projectTemplates.findFirst({
      where: and(eq(projectTemplates.id, templateId), eq(projectTemplates.orgId, orgId)),
      with: { tickets: { orderBy: (t, { asc }) => [asc(t.order)] } },
    });
    if (!template) throw new NotFoundException("Template not found");

    const namePart = input.name.replace(/[^a-zA-Z]/g, "").substring(0, 3).toUpperCase();
    const randomPart = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const key = (namePart.length >= 2 ? namePart : "PRJ") + "-" + randomPart;

    const [project] = await this.db
      .insert(projects)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? template.description ?? null,
        key,
        managerId: input.managerId ?? userId,
        startDate: input.startDate ? new Date(input.startDate) : null,
        endDate: input.endDate ? new Date(input.endDate) : null,
      })
      .returning();

    if (!project) throw new InternalServerErrorException("Failed to create project");

    await this.db.insert(projectMembers).values({ projectId: project.id, userId, role: "OWNER" });

    await this.db
      .insert(projectStatuses)
      .values(APPLY_DEFAULT_STATUSES.map((s) => ({ ...s, orgId, projectId: project.id })));

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
          order: t.order ?? i,
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
