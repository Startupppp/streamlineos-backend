import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, ne } from "drizzle-orm";
import { kbPageLinks, kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { CreateRecordLinkDto, RecordLinkByRecordQuery } from "./dto/kb-page-record-links.schemas";
import { pageVisibleTo } from "../retrieval/kb-page-visibility";
import { getAccessibleProjectIds } from "../retrieval/kb-project-access.util";

@Injectable()
export class KbPageRecordLinksService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async list(user: CurrentUserContext, pageId: number) {
    await this.assertPageAccessible(user, pageId);
    return this.db
      .select({
        id: kbPageLinks.id,
        targetType: kbPageLinks.targetType,
        targetId: kbPageLinks.targetId,
        label: kbPageLinks.label,
      })
      .from(kbPageLinks)
      .where(
        and(
          eq(kbPageLinks.sourcePageId, pageId),
          eq(kbPageLinks.orgId, user.orgId),
          ne(kbPageLinks.targetType, "page"),
        ),
      );
  }

  async add(user: CurrentUserContext, pageId: number, dto: CreateRecordLinkDto) {
    await this.assertPageAccessible(user, pageId);

    const existing = await this.db.query.kbPageLinks.findFirst({
      where: and(
        eq(kbPageLinks.sourcePageId, pageId),
        eq(kbPageLinks.orgId, user.orgId),
        eq(kbPageLinks.targetType, dto.targetType),
        eq(kbPageLinks.targetId, dto.targetId),
      ),
    });
    if (existing) throw new ConflictException("Record link already exists");

    const [row] = await this.db
      .insert(kbPageLinks)
      .values({
        orgId: user.orgId,
        sourcePageId: pageId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        label: dto.label,
      })
      .returning({
        id: kbPageLinks.id,
        targetType: kbPageLinks.targetType,
        targetId: kbPageLinks.targetId,
        label: kbPageLinks.label,
      });
    return row;
  }

  async remove(user: CurrentUserContext, linkId: number) {
    const link = await this.db.query.kbPageLinks.findFirst({
      where: and(eq(kbPageLinks.id, linkId), eq(kbPageLinks.orgId, user.orgId)),
      columns: { id: true },
    });
    if (!link) throw new NotFoundException("Link not found");

    await this.db
      .delete(kbPageLinks)
      .where(and(eq(kbPageLinks.id, linkId), eq(kbPageLinks.orgId, user.orgId)));
    return { success: true };
  }

  async listByRecord(user: CurrentUserContext, query: RecordLinkByRecordQuery) {
    const projectIds = await getAccessibleProjectIds(this.db, user);
    return this.db
      .select({
        pageId: kbPages.id,
        title: kbPages.title,
        icon: kbPages.icon,
      })
      .from(kbPageLinks)
      .innerJoin(kbPages, eq(kbPageLinks.sourcePageId, kbPages.id))
      .where(
        and(
          eq(kbPageLinks.orgId, user.orgId),
          eq(kbPageLinks.targetType, query.targetType),
          eq(kbPageLinks.targetId, query.targetId),
          isNull(kbPages.deletedAt),
          pageVisibleTo(user, projectIds),
        ),
      )
      .limit(50);
  }

  private async assertPageAccessible(user: CurrentUserContext, pageId: number) {
    const projectIds = await getAccessibleProjectIds(this.db, user);
    const page = await this.db.query.kbPages.findFirst({
      where: and(
        eq(kbPages.id, pageId),
        eq(kbPages.orgId, user.orgId),
        isNull(kbPages.deletedAt),
        pageVisibleTo(user, projectIds),
      ),
      columns: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
  }
}
