import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { VerifyPageInput } from "./dto/kb-pages.schemas";
import { computeVerificationInterval } from "./kb-page-governance.util";
import { KbPageReviewsService } from "./kb-page-reviews.service";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { actingMembershipId } from "../../../common/auth/principal";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";

type PageRow = KbPageRow;

@Injectable()
export class KbPageStatusService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly reviews: KbPageReviewsService,
    private readonly auth: KnowledgeAuthorizationService,
  ) {}

  private membershipId(user: CurrentUserContext): number | null {
    return user.principal === undefined ? null : actingMembershipId(user.principal);
  }

  private async setStatus(
    user: CurrentUserContext,
    pageId: number,
    status: "draft" | "in_review" | "published" | "archived",
  ): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");
    const [updated] = await this.db
      .update(kbPages)
      .set({ status, lastEditedById: user.userId, lastEditedByMembershipId: this.membershipId(user) })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning(KB_PAGE_COLUMNS);
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async lock(user: CurrentUserContext, pageId: number, isLocked: boolean): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "manage");
    const orgId = user.orgId;
    const [updated] = await this.db
      .update(kbPages)
      .set({ isLocked, lastEditedById: user.userId, lastEditedByMembershipId: this.membershipId(user) })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)))
      .returning(KB_PAGE_COLUMNS);
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async publish(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({ status: "published", lastEditedById: user.userId, lastEditedByMembershipId: this.membershipId(user) })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(pageId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: { contentType: "page", contentId: pageId, contentRevision: updated.contentRevision, aclRevision: updated.aclRevision },
        occurredAt: new Date(),
      });
      return updated;
    });
  }

  async archive(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({ status: "archived", lastEditedById: user.userId, lastEditedByMembershipId: this.membershipId(user) })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(pageId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: { contentType: "page", contentId: pageId, contentRevision: updated.contentRevision, aclRevision: updated.aclRevision },
        occurredAt: new Date(),
      });
      return updated;
    });
  }

  async unarchive(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(kbPages)
        .set({ status: "draft", lastEditedById: user.userId, lastEditedByMembershipId: this.membershipId(user) })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");
      await OutboxWriter.emit(tx, {
        eventId: randomUUID(),
        organizationId: orgId,
        aggregateType: "kb_page",
        aggregateId: String(pageId),
        aggregateVersion: Date.now(),
        eventType: "kb.content.index",
        payload: { contentType: "page", contentId: pageId, contentRevision: updated.contentRevision, aclRevision: updated.aclRevision },
        occurredAt: new Date(),
      });
      return updated;
    });
  }

  async verify(user: CurrentUserContext, pageId: number, input: VerifyPageInput): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true, contentType: true },
    });
    if (!current) throw new NotFoundException("Page not found");

    const days = computeVerificationInterval(current.contentType, input.intervalDays);
    const now = new Date();
    const verifiedUntil = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const nextReviewAt = verifiedUntil;

    const [updated] = await this.db
      .update(kbPages)
      .set({
        trustState: "verified",
        verifiedById: user.userId,
        verifiedByMembershipId: this.membershipId(user),
        verifiedUntil,
        nextReviewAt,
        lastEditedById: user.userId,
        lastEditedByMembershipId: this.membershipId(user),
      })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning(KB_PAGE_COLUMNS);
    if (!updated) throw new NotFoundException("Page not found");
    return updated;
  }

  async markStale(user: CurrentUserContext, pageId: number): Promise<PageRow> {
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { id: true },
    });
    if (!current) throw new NotFoundException("Page not found");

    const [updated] = await this.db
      .update(kbPages)
      .set({ trustState: "verification_expired", lastEditedById: user.userId, lastEditedByMembershipId: this.membershipId(user) })
      .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
      .returning(KB_PAGE_COLUMNS);
    if (!updated) throw new NotFoundException("Page not found");

    await this.reviews.create(user, pageId, {
      type: "freshness",
      dueAt: new Date().toISOString(),
    });

    return updated;
  }

}
