import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { kbPages, kbPageVersions, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { actingMembershipId } from "../../../common/auth/principal";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { snapshotIfNeeded } from "./kb-page-edit.util";
import { KbPageWriterService } from "./kb-page-writer.service";
import { buildCursorPage, decodeCursor } from "../../../common/pagination/cursor";
import { keysetBeforeValue } from "../../../common/pagination/keyset";
import { KB_PAGE_COLUMNS, type KbPageRow } from "./kb-page-columns";

const PAGE_SIZE = 50;
const PAGE_SIZE_CAP = 100;

type PageRow = KbPageRow;

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
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly writer: KbPageWriterService,
  ) {}

  async listVersions(user: CurrentUserContext, pageId: number, cursor?: string, pageSize = PAGE_SIZE) {
    const orgId = user.orgId;
    const limit = Math.min(Math.max(pageSize, 1), PAGE_SIZE_CAP);
    await this.auth.assertPageAccess(user, pageId, "view");
    const position = decodeCursor(cursor);
    const rows = await this.db
      .select(VERSION_COLUMNS)
      .from(kbPageVersions)
      .leftJoin(users, eq(kbPageVersions.authorId, users.id))
      .where(
        position
          ? and(
              eq(kbPageVersions.pageId, pageId),
              eq(kbPageVersions.orgId, orgId),
              keysetBeforeValue(kbPageVersions.versionNumber, kbPageVersions.id, position),
            )
          : and(eq(kbPageVersions.pageId, pageId), eq(kbPageVersions.orgId, orgId)),
      )
      .orderBy(desc(kbPageVersions.versionNumber), desc(kbPageVersions.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.versionNumber),
      id: String(row.id),
    }));
  }

  async getVersion(user: CurrentUserContext, pageId: number, versionNumber: number) {
    const orgId = user.orgId;
    await this.auth.assertPageAccess(user, pageId, "view");
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
    await this.auth.assertPageAccess(user, pageId, "edit");
    const orgId = user.orgId;
    const current = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), isNull(kbPages.deletedAt)),
      columns: { fts: false },
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
        .returning(KB_PAGE_COLUMNS);
      if (!updated) throw new NotFoundException("Page not found");

      await tx.execute(
        sql`INSERT INTO "public"."kb_version_restore_audit"
          ("org_id", "page_id", "source_version_number", "actor_user_id", "actor_membership_id")
          VALUES (${orgId}, ${pageId}, ${versionNumber}, ${user.userId}, ${membershipId ?? null})`,
      );

      await this.writer.commitPageChange(tx, {
        orgId,
        actor: { userId: user.userId, membershipId },
        action: "kb.page.version_restored",
        page: updated,
        changed: version.content
          ? {
              content: {
                newContent: version.content,
                previousContent: current.content ?? null,
                changeSummary: `Restored from version ${versionNumber}`,
                forced: true,
              },
            }
          : {},
      });

      return updated;
    });
  }
}
