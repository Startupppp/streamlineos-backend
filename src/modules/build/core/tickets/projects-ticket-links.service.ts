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
  organizationMembers,
  ticketAttachments,
  ticketRelatedLinks,
} from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { AccessService } from "../../../access/access.service";
import { assertTicketReadAccess, type TicketReadAccess } from "../project-crud/project-access";
import type {
  AddRelatedLinkInput,
  AttachmentInput,
  UpdateRelatedLinkInput,
} from "../dto/projects.schemas";

@Injectable()
export class ProjectsTicketLinksService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: TicketReadAccess,
  ) {}

  private async assertTicketAccess(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
  }

  async getGitLinks(u: CurrentUserContext, projectId: number, ticketId: number) {
    await this.assertTicketAccess(u, projectId, ticketId);

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
          eq(gitTicketLinks.orgId, u.orgId),
        ),
      )
      .orderBy(desc(gitTicketLinks.createdAt))
      .limit(100);
  }

  async addAttachment(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AttachmentInput,
  ) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const [attachment] = await this.db
      .insert(ticketAttachments)
      .values({
        orgId: u.orgId,
        ticketId,
        fileUrl: body.fileUrl,
        fileName: body.fileName,
        fileSize: body.fileSize,
        mimeType: body.mimeType,
        uploadedBy: u.userId,
      })
      .returning();
    return { id: attachment.id };
  }

  private toRelatedLinkRow(
    row: { id: number; orgId: string; ticketId: number; url: string; label: string | null; createdBy: string | null; createdAt: Date },
    projectId: number,
  ) {
    return {
      id: row.id,
      orgId: row.orgId,
      projectId,
      ticketId: row.ticketId,
      url: row.url,
      title: row.label,
      description: null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    };
  }

  async listRelatedLinks(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
  ) {
    await this.assertTicketAccess(u, projectId, ticketId);
    const rows = await this.db
      .select({
        id: ticketRelatedLinks.id,
        orgId: ticketRelatedLinks.orgId,
        ticketId: ticketRelatedLinks.ticketId,
        url: ticketRelatedLinks.url,
        label: ticketRelatedLinks.label,
        createdBy: ticketRelatedLinks.createdBy,
        createdAt: ticketRelatedLinks.createdAt,
      })
      .from(ticketRelatedLinks)
      .where(
        and(
          eq(ticketRelatedLinks.orgId, u.orgId),
          eq(ticketRelatedLinks.ticketId, ticketId),
        ),
      )
      .orderBy(ticketRelatedLinks.createdAt)
      .limit(50);
    return rows.map((row) => this.toRelatedLinkRow(row, projectId));
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
      .where(
        and(eq(ticketRelatedLinks.orgId, u.orgId), eq(ticketRelatedLinks.ticketId, ticketId)),
      );
    if (existing.length >= 20)
      throw new BadRequestException("A ticket can have at most 20 related links");
    const [membership] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, u.orgId), eq(organizationMembers.userId, u.userId)))
      .limit(1);
    const [created] = await this.db
      .insert(ticketRelatedLinks)
      .values({
        orgId: u.orgId,
        ticketId,
        url: body.url,
        label: body.label ?? null,
        createdBy: u.userId,
        createdByMembershipId: membership?.id ?? null,
      })
      .returning();
    if (!created) throw new NotFoundException("Related link not found after creation");
    return this.toRelatedLinkRow(created, projectId);
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
          eq(ticketRelatedLinks.orgId, u.orgId),
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
          eq(ticketRelatedLinks.orgId, u.orgId),
          eq(ticketRelatedLinks.id, linkId),
          eq(ticketRelatedLinks.ticketId, ticketId),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundException("Related link not found");
    return this.toRelatedLinkRow(updated, projectId);
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
          eq(ticketRelatedLinks.orgId, u.orgId),
          eq(ticketRelatedLinks.id, linkId),
          eq(ticketRelatedLinks.ticketId, ticketId),
        ),
      );
    if (!link) throw new NotFoundException("Related link not found");
    if (link.createdBy !== u.userId && !u.isOrgOwner)
      throw new ForbiddenException("Cannot delete another user's link");
    await this.db.delete(ticketRelatedLinks).where(
      and(
        eq(ticketRelatedLinks.orgId, u.orgId),
        eq(ticketRelatedLinks.id, linkId),
        eq(ticketRelatedLinks.ticketId, ticketId),
      ),
    );
  }
}
