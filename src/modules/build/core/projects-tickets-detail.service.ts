import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { ticketComments, tickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { AccessService } from "../../access/access.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolveTicketsScope, ticketScope } from "./tickets-scope";
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

  async getTicketByKey(
    u: CurrentUserContext,
    projectId: number,
    ticketNumber: number,
  ) {
    return this.readTicket(
      u,
      and(
        eq(tickets.projectId, projectId),
        eq(tickets.ticketNumber, ticketNumber),
      ),
    );
  }

  async getTicket(u: CurrentUserContext, projectId: number, ticketId: number) {
    return this.readTicket(
      u,
      and(eq(tickets.id, ticketId), eq(tickets.projectId, projectId)),
    );
  }

  private async readTicket(
    u: CurrentUserContext,
    selector: SQL<unknown> | undefined,
  ) {
    const read = await resolveTicketsScope(this.access, u);
    if (read.denied) throw new ProjectsForbiddenTicketException();
    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.orgId, u.orgId),
        isNull(tickets.deletedAt),
        selector,
      ),
      with: {
        project: { columns: { id: true, name: true, key: true, orgId: true } },
        cycle: { columns: { id: true, name: true, legacySprintId: true } },
        assignee: { with: { user: { columns: USER_COLS } } },
        reporter: { columns: USER_COLS },
        assignees: {
          with: { user: { with: { user: { columns: USER_COLS } } } },
        },
        watchers: {
          with: { user: { with: { user: { columns: USER_COLS } } } },
        },
        comments: {
          where: isNull(ticketComments.deletedAt),
          with: {
            user: { columns: USER_COLS },
            reactions: {
              columns: { emoji: true },
              with: { membership: { columns: { userId: true } } },
              limit: 100,
            },
          },
          orderBy: [desc(ticketComments.createdAt)],
          limit: 50,
        },
        attachments: { with: { uploader: { columns: USER_COLS } } },
        labels: {
          with: { label: { columns: { id: true, name: true, color: true } } },
        },
      },
    });
    if (!ticket) throw new ProjectsTicketNotFoundException();
    if (!read.unrestricted) {
      const isAssignee =
        ticket.assignee?.user?.id === u.userId ||
        ticket.assignees.some(
          (assignment) => assignment.user?.userId === u.userId,
        );
      if (!isAssignee && ticket.reporterId !== u.userId) {
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
    const epic = ticket.epicId
      ? await read.read(
          {
            tenant: tickets.orgId,
            scope: ticketScope(read.orgId, read.actorId),
            and: [eq(tickets.id, ticket.epicId), isNull(tickets.deletedAt)],
          },
          ({ sql: where }) =>
            this.db.query.tickets.findFirst({
              where,
              columns: { id: true, title: true },
            }),
          () => undefined,
        )
      : null;
    return {
      ...ticket,
      sprintId: ticket.cycle?.legacySprintId ?? null,
      epic: epic ? { id: epic.id, name: epic.title } : null,
      members: ticket.assignees,
      watchers: (ticket.watchers ?? []).map((watcher) => ({
        ...watcher,
        user: watcher.user?.user ?? null,
      })),
      attachments: ticket.attachments.map((attachment) => ({
        ...attachment,
        filename: attachment.fileName,
        url: attachment.fileUrl,
      })),
      labels: ticket.labels.flatMap((mapping) =>
        mapping.label ? [mapping.label] : [],
      ),
      comments: (ticket.comments ?? []).map((comment) => ({
        ...comment,
        reactions: (comment.reactions ?? []).flatMap((reaction) => {
          const userId = reaction.membership?.userId;
          if (!userId) return [];
          return [{ emoji: reaction.emoji, userId }];
        }),
      })),
    };
  }
}
