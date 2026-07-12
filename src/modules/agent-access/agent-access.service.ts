import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { projects, ticketAttachments, ticketComments, tickets, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class AgentAccessService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async resolveTicketOrgScoped(orgId: string, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: { id: true, projectId: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");
    return ticket;
  }

  async getTicketDetail(orgId: string, ticketId: number) {
    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)),
      columns: {
        id: true, title: true, status: true, priority: true, type: true,
        description: true, ticketNumber: true, projectId: true,
        assigneeId: true, dueDate: true, createdAt: true, updatedAt: true,
      },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    const [comments, attachments] = await Promise.all([
      this.db
        .select({
          id: ticketComments.id,
          body: ticketComments.content,
          authorId: ticketComments.userId,
          authorName: users.name,
          authorFirstName: users.firstName,
          authorLastName: users.lastName,
          createdAt: ticketComments.createdAt,
        })
        .from(ticketComments)
        .leftJoin(users, eq(users.id, ticketComments.userId))
        .where(and(eq(ticketComments.ticketId, ticketId), eq(ticketComments.orgId, orgId)))
        .orderBy(desc(ticketComments.createdAt))
        .limit(50),
      this.db
        .select({
          id: ticketAttachments.id,
          fileName: ticketAttachments.fileName,
          fileUrl: ticketAttachments.fileUrl,
          mimeType: ticketAttachments.mimeType,
          fileSize: ticketAttachments.fileSize,
        })
        .from(ticketAttachments)
        .where(and(eq(ticketAttachments.ticketId, ticketId), eq(ticketAttachments.orgId, orgId))),
    ]);

    const pid = ticket.projectId;
    let proj: { id: number; key: string; name: string } | null = null;
    if (pid !== null) {
      const projRows = await this.db
        .select({ id: projects.id, key: projects.key, name: projects.name })
        .from(projects)
        .where(and(eq(projects.id, pid), eq(projects.orgId, orgId)))
        .limit(1);
      proj = projRows[0] ?? null;
    }

    const shapedComments = comments.map((c) => {
      const fallback = `${c.authorFirstName ?? ""} ${c.authorLastName ?? ""}`.trim();
      return {
        id: c.id,
        body: c.body,
        authorId: c.authorId,
        authorName: c.authorName ?? (fallback.length > 0 ? fallback : null),
        createdAt: c.createdAt,
      };
    });

    return { ...ticket, project: proj, comments: shapedComments, attachments };
  }
}
