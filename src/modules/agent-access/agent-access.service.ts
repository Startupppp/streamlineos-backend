import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { projects, ticketAttachments, ticketComments, tickets, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

function extractImageUrls(html: string | null): string[] {
  if (!html) return [];
  const urls: string[] = [];
  const pattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match = pattern.exec(html);
  while (match) {
    const url = match[1];
    if (url && /^https?:\/\//i.test(url)) urls.push(url);
    match = pattern.exec(html);
  }
  return urls;
}

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

    const seen = new Set<string>();
    const inlineImages: { url: string; source: "description" | "comment" }[] = [];
    for (const url of extractImageUrls(ticket.description)) {
      if (!seen.has(url)) {
        seen.add(url);
        inlineImages.push({ url, source: "description" });
      }
    }
    for (const comment of shapedComments) {
      for (const url of extractImageUrls(comment.body)) {
        if (!seen.has(url)) {
          seen.add(url);
          inlineImages.push({ url, source: "comment" });
        }
      }
    }
    for (const attachment of attachments) {
      if (attachment.fileUrl) seen.add(attachment.fileUrl);
    }

    return { ...ticket, project: proj, comments: shapedComments, attachments, inlineImages };
  }
}
