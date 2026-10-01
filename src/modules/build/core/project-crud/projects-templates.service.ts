import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  projectMembers,
  projects,
  projectStatuses,
  projectTemplates,
  projectTemplateTickets,
  ticketPriorityEnum,
  ticketTypeEnum,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { PlanLimitsService } from "../../../billing/core/plan-limits.service";
import { AuditService } from "../../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type {
  ApplyTemplateInput,
  CreateTemplateInput,
  ListTemplatesQuery,
} from "../dto/projects.schemas";
import { DEFAULT_PROJECT_STATUSES } from "../lib/default-statuses";
import { resolveOrganizationActorsByUserIds } from "../../../../common/organization/organization-actor";
import { buildCursorPage, decodeCursor } from "../../../../common/pagination/cursor";
import {
  keysetAfterValue,
  keysetBeforeId,
} from "../../../../common/pagination/keyset";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";
import { BuildTicketCreationService } from "../tickets";


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
    private readonly audit: AuditService,
    private readonly ticketCreation: BuildTicketCreationService,
  ) {}

  async listTemplates(orgId: string, query: ListTemplatesQuery) {
    const { cursor, q, category, sort } = query;
    const pos = decodeCursor(cursor);
    if (cursor !== undefined && pos === null) {
      throw new BadRequestException("Invalid pagination cursor");
    }

    const conds = [
      eq(projectTemplates.orgId, orgId),
      isNull(projectTemplates.deletedAt),
      category !== undefined ? eq(projectTemplates.category, category) : undefined,
      q !== undefined
        ? sql`to_tsvector('english', ${projectTemplates.name}) @@ plainto_tsquery('english', ${q})`
        : undefined,
    ];
    if (pos) {
      if (sort === "name") {
        conds.push(keysetAfterValue(projectTemplates.name, projectTemplates.id, pos));
      } else {
        conds.push(keysetBeforeId(projectTemplates.createdAt, projectTemplates.id, pos));
      }
    }

    const orderBy =
      sort === "name"
        ? [asc(projectTemplates.name), asc(projectTemplates.id)]
        : [desc(projectTemplates.createdAt), desc(projectTemplates.id)];

    const rows = await this.db
      .select({
        id: projectTemplates.id,
        orgId: projectTemplates.orgId,
        name: projectTemplates.name,
        description: projectTemplates.description,
        category: projectTemplates.category,
        createdBy: projectTemplates.createdBy,
        deletedAt: projectTemplates.deletedAt,
        createdAt: projectTemplates.createdAt,
      })
      .from(projectTemplates)
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(PAGE_SIZE_CAP + 1);

    const page = buildCursorPage(rows, PAGE_SIZE_CAP, (r) => {
      if (sort === "name") return { sortValue: r.name, id: String(r.id) };
      return { sortValue: (r.createdAt ?? new Date(0)).toISOString(), id: String(r.id) };
    });

    if (page.data.length === 0) return page;

    const templateIds = page.data.map((r) => r.id);
    const templateTickets = await this.db
      .select({
        id: projectTemplateTickets.id,
        templateId: projectTemplateTickets.templateId,
        title: projectTemplateTickets.title,
        description: projectTemplateTickets.description,
        type: projectTemplateTickets.type,
        priority: projectTemplateTickets.priority,
        estimatedHours: projectTemplateTickets.estimatedHours,
        order: projectTemplateTickets.order,
        phase: projectTemplateTickets.phase,
      })
      .from(projectTemplateTickets)
      .where(
        and(
          inArray(projectTemplateTickets.templateId, templateIds),
          eq(projectTemplateTickets.orgId, orgId),
        ),
      )
      .orderBy(asc(projectTemplateTickets.order));

    const ticketsByTemplateId = new Map<number, typeof templateTickets>();
    for (const ticket of templateTickets) {
      const list = ticketsByTemplateId.get(ticket.templateId) ?? [];
      list.push(ticket);
      ticketsByTemplateId.set(ticket.templateId, list);
    }

    return {
      ...page,
      data: page.data.map((r) => ({
        ...r,
        tickets: ticketsByTemplateId.get(r.id) ?? [],
      })),
    };
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

  async deleteTemplate(u: CurrentUserContext, templateId: number) {
    const orgId = u.orgId;
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
      .returning({ id: projectTemplates.id, name: projectTemplates.name });
    if (!stamped) throw new NotFoundException("Template not found");
    await this.audit.logCritical({
      action: "build.template.deleted",
      userId: u.userId,
      orgId,
      targetId: String(templateId),
      targetType: "project_template",
      metadata: { name: stamped.name },
    });
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
      await this.ticketCreation.create({
        orgId,
        projectId: project.id,
        actor: { userId, membershipId: creator.membershipId },
        drafts: template.tickets.map((t, i) => ({
          title: t.title,
          description: t.description ?? null,
          type: normalizeTicketType(t.type),
          status: "TODO",
          priority: normalizeTicketPriority(t.priority),
          rank: String(((t.order ?? i) + 1) * 1000),
          originalEstimate: t.estimatedHours ? String(t.estimatedHours) : null,
          reporterId: userId,
        })),
      });
    }

    return {
      projectId: project.id,
      key: project.key,
      ticketsCreated: template.tickets.length,
    };
  }
}
