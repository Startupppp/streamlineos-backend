import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ticketComments, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveTicketsScope } from "./tickets-scope";
import {
  ProjectsForbiddenTicketException,
  ProjectsTicketNotFoundException,
} from "../../../common/http/api-exceptions";

const USER_COLS = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  email: true,
  image: true,
} as const;

@Injectable()
export class ProjectsTicketsDetailService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async getTicketByKey(u: CurrentUserContext, projectId: number, ticketNumber: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.orgId, u.orgId),
        eq(tickets.projectId, projectId),
        eq(tickets.ticketNumber, ticketNumber),
        isNull(tickets.deletedAt),
      ),
      with: {
        project: {
          columns: { id: true, name: true, key: true, orgId: true },
        },
        sprint: {
          columns: { id: true, name: true },
        },
        assignee: { columns: USER_COLS },
        reporter: { columns: USER_COLS },
        assignees: {
          with: { user: { columns: USER_COLS } },
        },
        comments: {
          where: isNull(ticketComments.deletedAt),
          with: { user: { columns: USER_COLS } },
          orderBy: [desc(ticketComments.createdAt)],
          limit: 50,
        },
        attachments: {
          with: {
            uploader: { columns: USER_COLS },
          },
        },
        labels: {
          with: {
            label: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
      },
    });
    if (!ticket) throw new ProjectsTicketNotFoundException();

    const scope = await resolveTicketsScope(this.access, u);
    if (scope !== "all") {
      const isAssignee =
        ticket.assigneeId === u.userId ||
        ticket.assignees.some((a) => a.userId === u.userId);
      const isReporter = ticket.reporterId === u.userId;
      if (!isAssignee && !isReporter) {
        this.audit.log({
          action: "ticket.access_denied",
          userId: u.userId,
          orgId: u.orgId,
          targetId: String(ticket.id),
          targetType: "ticket",
          metadata: {
            ticketId: ticket.id,
            projectId: ticket.projectId,
            reason: "RESTRICTED_SCOPE",
          },
          result: "FAILURE",
        });
        throw new ProjectsForbiddenTicketException();
      }
    }

    return ticket;
  }

  async getTicket(u: CurrentUserContext, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId), isNull(tickets.deletedAt)),
      with: {
        project: {
          columns: { id: true, name: true, key: true, orgId: true },
        },
        sprint: {
          columns: { id: true, name: true },
        },
        assignee: { columns: USER_COLS },
        reporter: { columns: USER_COLS },
        assignees: {
          with: { user: { columns: USER_COLS } },
        },
        comments: {
          where: isNull(ticketComments.deletedAt),
          with: { user: { columns: USER_COLS } },
          orderBy: [desc(ticketComments.createdAt)],
          limit: 50,
        },
        attachments: {
          with: {
            uploader: { columns: USER_COLS },
          },
        },
        labels: {
          with: {
            label: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
      },
    });
    if (!ticket) throw new ProjectsTicketNotFoundException();

    const scope = await resolveTicketsScope(this.access, u);
    if (scope !== "all") {
      const isAssignee =
        ticket.assigneeId === u.userId ||
        ticket.assignees.some((a) => a.userId === u.userId);
      const isReporter = ticket.reporterId === u.userId;
      if (!isAssignee && !isReporter) {
        this.audit.log({
          action: "ticket.access_denied",
          userId: u.userId,
          orgId: u.orgId,
          targetId: String(ticketId),
          targetType: "ticket",
          metadata: {
            ticketId,
            projectId: ticket.projectId,
            reason: "RESTRICTED_SCOPE",
          },
          result: "FAILURE",
        });
        throw new ProjectsForbiddenTicketException();
      }
    }

    return ticket;
  }
}
