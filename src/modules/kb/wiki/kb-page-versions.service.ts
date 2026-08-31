import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageVersions, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { assertPageAccessible } from "../retrieval/kb-page-access.util";
import { resyncPageLinks, snapshotIfNeeded } from "./kb-page-edit.util";

type PageRow = typeof kbPages.$inferSelect;

const VERSION_COLUMNS = {
  id: kbPageVersions.id,
  orgId: kbPageVersions.orgId,
  pageId: kbPageVersions.pageId,
  versionNumber: kbPageVersions.versionNumber,
  title: kbPageVersions.title,
  content: kbPageVersions.content,
  contentText: kbPageVersions.contentText,
  changeSummary: kbPageVersions.changeSummary,
  authorId: kbPageVersions.authorId,
  authorMembershipId: kbPageVersions.authorMembershipId,
  authorName: users.name,
  createdAt: kbPageVersions.createdAt,
};

@Injectable()
export class KbPageVersionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listVersions(user: CurrentUserContext, pageId: number) {
    const orgId = user.orgId;
    await assertPageAccessible(this.db, user, pageId);
    return this.db
      .select(VERSION_COLUMNS)
      .from(kbPageVersions)
      .leftJoin(users, eq(kbPageVersions.authorId, users.id))
      .where(and(eq(kbPageVersions.pageId, pageId), eq(kbPageVersions.orgId, orgId)))
      .orderBy(desc(kbPageVersions.versionNumber))
      .limit(100);
  }

  async getVersion(user: CurrentUserContext, pageId: number, versionNumber: number) {
    const orgId = user.orgId;
    await assertPageAccessible(this.db, user, pageId);
    const rows = await this.db
      .select(VERSION_COLUMNS)
      .from(kbPageVersions)
      .leftJoin(users, eq(kbPageVersions.authorId, users.id))
      .where(
        and(
          eq(kbPageVersions.pageId, pageId),
          eq(kbPageVersions.versionNumber, versionNumber),
          eq(kbPageVersions.orgId, orgId),
        ),
      );
    const version = rows[0];
    if (!version) throw new NotFoundException("Version not found");
    return version;
  }

  async restoreVersion(
    user: CurrentUserContext,
    pageId: number,
    versionNumber: number,
    canManage: boolean,
  ): Promise<PageRow> {
    await assertPageAccessible(this.db, user, pageId);
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
    });
    if (!current) throw new NotFoundException("Page not found");

    if (current.isLocked && !canManage) {
      throw new HttpException(
        { message: "Page is locked", code: "PAGE_LOCKED" },
        HttpStatus.CONFLICT,
      );
    }

    const version = await this.db.query.kbPageVersions.findFirst({
      where: and(
        eq(kbPageVersions.pageId, pageId),
        eq(kbPageVersions.versionNumber, versionNumber),
        eq(kbPageVersions.orgId, orgId),
      ),
    });
    if (!version) throw new NotFoundException("Version not found");

    const membershipId = actingMembershipId(user.principal);
    return this.db.transaction(async (tx) => {
      await snapshotIfNeeded(tx, orgId, current, user.userId, null, true, membershipId);

      const [updated] = await tx
        .update(kbPages)
        .set({
          title: version.title,
          content: version.content,
          contentText: version.contentText,
          lastEditedById: user.userId,
          contentRevision: sql`content_revision + 1`,
        })
        .where(and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)))
        .returning();
      if (!updated) throw new NotFoundException("Page not found");

      await snapshotIfNeeded(
        tx,
        orgId,
        updated,
        user.userId,
        `Restored from version ${versionNumber}`,
        true,
        membershipId,
      );

      if (version.content) {
        await resyncPageLinks(tx, orgId, pageId, version.content);
      }

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
}
