import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  projectMembers,
  projects,
  ticketComments,
  tickets,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { AuditService } from "../../common/audit/audit.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { resolveTicketsScope } from "./tickets-scope";
import {
  ProjectsForbiddenTicketException,
  ProjectsTicketNotFoundException,
} from "../../common/http/api-exceptions";
import type { TicketsListQuery } from "./dto/projects.schemas";

const TICKET_ORDERBY_COLUMNS = {
  created: tickets.createdAt,
  updated: tickets.updatedAt,
  priority: tickets.priority,
  dueDate: tickets.dueDate,
  order: tickets.order,
} as const;

@Injectable()
export class ProjectsTicketsReadService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async checkProjectAccess(
    orgId: string,
    userId: string,
    projectId: number,
  ): Promise<{ hasAccess: boolean; role: string | null }> {
    const perms = await this.access.resolveUserPermissions(orgId, userId);
    if (perms.has("projects:manage")) return { hasAccess: true, role: "OWNER" };
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { managerId: true },
    });
    if (!project) return { hasAccess: false, role: null };
    if (project.managerId === userId) return { hasAccess: true, role: "MANAGER" };
    const membership = await this.db
      .select({ id: projectMembers.id, role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
      .limit(1);
    if (membership.length === 0) return { hasAccess: false, role: null };
    return { hasAccess: true, role: membership[0]?.role ?? null };
  }

  async listTickets(u: CurrentUserContext, projectId: number, query: TicketsListQuery) {
    const { hasAccess } = await this.checkProjectAccess(u.orgId, u.userId, projectId);
    if (!hasAccess) throw new NotFoundException("Not found");

    const {
      page,
      limit,
      search,
      status,
      priority,
      type,
      assigneeId,
      labelIds,
      sprintId,
      cycleId,
      epicId,
      dueDateFrom,
      dueDateTo,
      orderBy,
      orderDir,
    } = query;
    const offset = (page - 1) * limit;

    const conditions: SQL<unknown>[] = [
      eq(tickets.orgId, u.orgId),
      eq(tickets.projectId, projectId),
    ];

    if (search && search.trim()) {
      const term = search.trim();
      const isTicketRef = /^[A-Za-z]+-\d+$/.test(term) || /^#?\d+$/.test(term);
      if (isTicketRef) {
        const numStr = term.replace(/^#/, "").replace(/^[A-Za-z]+-/, "");
        const num = parseInt(numStr, 10);
        const searchCondition = or(
          sql`${tickets.title} ILIKE ${"%" + term + "%"}`,
          isNaN(num) ? sql`false` : eq(tickets.ticketNumber, num),
        );
        if (searchCondition) {
          conditions.push(searchCondition);
        }
      } else {
        conditions.push(sql`${tickets.title} ILIKE ${"%" + term + "%"}`);
      }
    }

    if (status && status.length > 0) {
      conditions.push(inArray(tickets.status, status));
    }

    if (priority && priority.length > 0) {
      conditions.push(inArray(tickets.priority, priority));
    }

    if (type && type.length > 0) {
      conditions.push(
        sql`${tickets.type}::text = ANY(ARRAY[${sql.join(type.map((t) => sql`${t}`), sql`, `)}])`,
      );
    }

    if (assigneeId && assigneeId.length > 0) {
      const unassigned = assigneeId.includes("__unassigned__");
      const realIds = assigneeId.filter((id) => id !== "__unassigned__");
      if (unassigned && realIds.length > 0) {
        const assigneeCondition = or(isNull(tickets.assigneeId), inArray(tickets.assigneeId, realIds));
        if (assigneeCondition) {
          conditions.push(assigneeCondition);
        }
      } else if (unassigned) {
        conditions.push(isNull(tickets.assigneeId));
      } else {
        conditions.push(inArray(tickets.assigneeId, realIds));
      }
    }

    if (labelIds && labelIds.length > 0) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ticket_label_mappings tlm
          WHERE tlm.ticket_id = ${tickets.id}
          AND tlm.label_id = ANY(ARRAY[${sql.join(labelIds.map((id) => sql`${id}`), sql`, `)}]::int[])
        )`,
      );
    }

    if (sprintId !== undefined) {
      conditions.push(eq(tickets.sprintId, sprintId));
    }

    if (cycleId && cycleId.length > 0) {
      conditions.push(inArray(tickets.cycleId, cycleId));
    }

    if (epicId !== undefined) {
      conditions.push(eq(tickets.epicId, epicId));
    }

    if (dueDateFrom) {
      conditions.push(gte(tickets.dueDate, dueDateFrom));
    }

    if (dueDateTo) {
      conditions.push(lte(tickets.dueDate, dueDateTo));
    }

    const where = and(...conditions);

    const col = TICKET_ORDERBY_COLUMNS[orderBy];
    const defaultDir = orderBy === "created" || orderBy === "updated" ? "desc" : "asc";
    const dir = orderDir ?? defaultDir;

    const sortExpr =
      orderBy === "order"
        ? [asc(tickets.order), desc(tickets.createdAt)]
        : dir === "asc"
        ? [asc(col), desc(tickets.createdAt)]
        : [desc(col), desc(tickets.createdAt)];

    const [dataResult, countResult] = await Promise.all([
      this.db.query.tickets.findMany({
        where,
        with: {
          assignee: true,
          reporter: true,
          assignees: { with: { user: true } },
          labels: { with: { label: true } },
        },
        orderBy: sortExpr,
        limit,
        offset,
      }),
      this.db.select({ total: count() }).from(tickets).where(where),
    ]);

    const total = countResult[0]?.total ?? 0;
    return {
      data: dataResult,
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(Number(total) / limit),
    };
  }

  async getTicket(u: CurrentUserContext, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)),
      with: {
        project: true,
        sprint: true,
        assignee: true,
        reporter: true,
        assignees: { with: { user: true } },
        comments: { with: { user: true }, orderBy: [desc(ticketComments.createdAt)] },
        attachments: { with: { uploader: true } },
        labels: { with: { label: true } },
      },
    });
    if (!ticket) throw new ProjectsTicketNotFoundException();

    const scope = await resolveTicketsScope(this.access, u);
    if (scope !== "all") {
      const isAssignee =
        ticket.assigneeId === u.userId || ticket.assignees.some((a) => a.userId === u.userId);
      const isReporter = ticket.reporterId === u.userId;
      if (!isAssignee && !isReporter) {
        this.audit.log({
          action: "ticket.access_denied",
          userId: u.userId,
          orgId: u.orgId,
          targetId: String(ticketId),
          targetType: "ticket",
          metadata: { ticketId, projectId: ticket.projectId, reason: "RESTRICTED_SCOPE" },
          result: "FAILURE",
        });
        throw new ProjectsForbiddenTicketException();
      }
    }

    return ticket;
  }
}
