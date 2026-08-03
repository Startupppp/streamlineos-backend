import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  gitTicketLinks,
  projects,
  ticketRelatedLinks,
  tickets,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  AddRelatedLinkInput,
  UpdateRelatedLinkInput,
} from "./dto/projects.schemas";

@Injectable()
export class ProjectsTicketLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  private async assertTicketAccess(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    const [ticket] = await this.db
      .select({
        id: tickets.id,
        projectId: tickets.projectId,
        orgId: tickets.orgId,
      })
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, u.orgId)));
    if (!ticket || ticket.projectId !== projectId)
      throw new NotFoundException("Ticket not found");
  }

  async getGitLinks(orgId: string, projectId: number, ticketId: number) {
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.orgId, orgId)),
      columns: { id: true },
    });
    if (!project) throw new NotFoundException("Project not found");

    const ticket = await this.db.query.tickets.findFirst({
      where: and(
        eq(tickets.id, ticketId),
        eq(tickets.projectId, projectId),
        eq(tickets.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!ticket) throw new NotFoundException("Ticket not found");

    return this.db
      .select({
        id: gitTicketLinks.id,
        provider: gitTicketLinks.provider,
        refType: gitTicketLinks.refType,
        externalId: gitTicketLinks.externalId,
        title: gitTicketLinks.title,
        url: gitTicketLinks.url,
        author: gitTicketLinks.author,
        status: gitTicketLinks.status,
        createdAt: gitTicketLinks.createdAt,
      })
      .from(gitTicketLinks)
      .where(
        and(
          eq(gitTicketLinks.ticketId, ticketId),
          eq(gitTicketLinks.orgId, orgId),
        ),
      )
      .orderBy(desc(gitTicketLinks.createdAt))
      .limit(100);
  }

  async listRelatedLinks(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await this.assertTicketAccess(u, projectId, ticketId);
    return this.db
      .select({
        id: ticketRelatedLinks.id,
        url: ticketRelatedLinks.url,
        label: ticketRelatedLinks.label,
        createdAt: ticketRelatedLinks.createdAt,
      })
      .from(ticketRelatedLinks)
      .where(eq(ticketRelatedLinks.ticketId, ticketId))
      .orderBy(ticketRelatedLinks.createdAt)
      .limit(50);
  }

  async addRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddRelatedLinkInput,
  ) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const existing = await this.db
      .select({ id: ticketRelatedLinks.id })
      .from(ticketRelatedLinks)
      .where(eq(ticketRelatedLinks.ticketId, ticketId));
    if (existing.length >= 20)
      throw new BadRequestException("A ticket can have at most 20 related links");
    const [created] = await this.db
      .insert(ticketRelatedLinks)
      .values({
        orgId: u.orgId,
        ticketId,
        url: body.url,
        label: body.label ?? null,
        createdBy: u.userId,
      })
      .returning();
    return created;
  }

  async updateRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    linkId: number,
    body: UpdateRelatedLinkInput,
  ) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const [link] = await this.db
      .select({
        id: ticketRelatedLinks.id,
        createdBy: ticketRelatedLinks.createdBy,
      })
      .from(ticketRelatedLinks)
      .where(
        and(
          eq(ticketRelatedLinks.id, linkId),
          eq(ticketRelatedLinks.ticketId, ticketId),
        ),
      );
    if (!link) throw new NotFoundException("Related link not found");
    if (link.createdBy !== u.userId && !u.isOrgOwner)
      throw new ForbiddenException("Cannot edit another user's link");
    const update: { url?: string; label?: string | null } = {};
    if (body.url !== undefined) update.url = body.url;
    if (body.label !== undefined) update.label = body.label;
    const [updated] = await this.db
      .update(ticketRelatedLinks)
      .set(update)
      .where(
        and(
          eq(ticketRelatedLinks.id, linkId),
          eq(ticketRelatedLinks.ticketId, ticketId),
        ),
      )
      .returning();
    return updated;
  }

  async deleteRelatedLink(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    linkId: number,
  ) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const [link] = await this.db
      .select({
        id: ticketRelatedLinks.id,
        createdBy: ticketRelatedLinks.createdBy,
      })
      .from(ticketRelatedLinks)
      .where(
        and(
          eq(ticketRelatedLinks.id, linkId),
          eq(ticketRelatedLinks.ticketId, ticketId),
        ),
      );
    if (!link) throw new NotFoundException("Related link not found");
    if (link.createdBy !== u.userId && !u.isOrgOwner)
      throw new ForbiddenException("Cannot delete another user's link");
    await this.db.delete(ticketRelatedLinks).where(
      and(
        eq(ticketRelatedLinks.id, linkId),
        eq(ticketRelatedLinks.ticketId, ticketId),
      ),
    );
  }
}
