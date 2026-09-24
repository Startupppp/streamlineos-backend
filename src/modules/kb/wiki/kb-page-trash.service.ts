import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  BulkPageIdsInput,
  TrashPagesQuery,
} from "./dto/kb-pages.schemas";
import {
  KB_PAGE_LIST_COLUMNS,
  type KbPageListItem,
} from "./kb-page-columns";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { StorageService } from "../../storage/storage.service";
import {
  attemptPageAttachmentPurge,
  purgeOrphanedKbMedia,
  recordPageAttachmentPurge,
} from "./kb-page-attachment-purge";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import {
  buildCursorPage,
  decodeTimestampCursor,
  type CursorPage,
} from "../../../common/pagination/cursor";
import {
  keysetBeforeMicros,
  microsecondCursorValue,
} from "../../../common/pagination/keyset";
import { KbPageTreeService } from "./kb-page-tree.service";
import { collectSubtreeIds } from "./kb-page-subtree.util";

export interface BulkPageResult {
  pageId: number;
  result: "succeeded" | "denied" | "conflict" | "notFound";
}

const EXPIRED_PURGE_BATCH_SIZE = 500;

@Injectable()
export class KbPageTrashService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: KnowledgeAuthorizationService,
    private readonly tree: KbPageTreeService,
  ) {}

  async hardDelete(user: CurrentUserContext, pageId: number): Promise<void> {
    const orgId = user.orgId;
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId)),
      columns: { id: true, title: true },
    });
    if (!page) throw new NotFoundException("Page not found");

    const subtreeIds = await this.db.transaction((tx) =>
      collectSubtreeIds(tx, orgId, pageId),
    );
    const purgeKeys = await recordPageAttachmentPurge(
      this.db,
      orgId,
      subtreeIds,
    );

    await this.db.transaction(async (tx) => {
      await tx.delete(kbPages).where(
        and(
          eq(kbPages.orgId, orgId),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            subtreeIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
    });

    await attemptPageAttachmentPurge(
      this.db,
      this.storage,
      orgId,
      purgeKeys,
      this.config.R2_KB_BUCKET_NAME,
    );

    this.audit.log({
      action: "kb.page.permanently_deleted",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      resourceId: String(pageId),
      metadata: { pageTitle: page.title },
    });
  }

  async emptyTrash(user: CurrentUserContext): Promise<{ purgedCount: number }> {
    const orgId = user.orgId;
    let purgedCount = 0;

    for (;;) {
      const trashed = await this.db
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(and(eq(kbPages.orgId, orgId), isNotNull(kbPages.deletedAt)))
        .orderBy(kbPages.id)
        .limit(EXPIRED_PURGE_BATCH_SIZE);

      if (trashed.length === 0) break;

      const ids = trashed.map((p) => p.id);
      const purgeKeys = await recordPageAttachmentPurge(this.db, orgId, ids);

      const deleted = await this.db
        .delete(kbPages)
        .where(and(eq(kbPages.orgId, orgId), inArray(kbPages.id, ids)))
        .returning({ id: kbPages.id });

      await attemptPageAttachmentPurge(
        this.db,
        this.storage,
        orgId,
        purgeKeys,
        this.config.R2_KB_BUCKET_NAME,
      );

      purgedCount += deleted.length;
      if (trashed.length < EXPIRED_PURGE_BATCH_SIZE) break;
    }

    if (purgedCount === 0) return { purgedCount: 0 };

    this.audit.log({
      action: "kb.trash.emptied",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      metadata: { purgedCount },
    });

    return { purgedCount };
  }

  async purgeExpired(orgId: string, olderThan: Date): Promise<number> {
    let purgedCount = 0;
    for (;;) {
      const expired = await this.db
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNotNull(kbPages.deletedAt),
            lt(kbPages.deletedAt, olderThan),
          ),
        )
        .orderBy(kbPages.id)
        .limit(EXPIRED_PURGE_BATCH_SIZE);

      if (expired.length === 0) break;

      const ids = expired.map((p) => p.id);
      const purgeKeys = await recordPageAttachmentPurge(this.db, orgId, ids);
      await this.db.delete(kbPages).where(
        and(
          eq(kbPages.orgId, orgId),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
      await attemptPageAttachmentPurge(
        this.db,
        this.storage,
        orgId,
        purgeKeys,
        this.config.R2_KB_BUCKET_NAME,
      );
      purgedCount += ids.length;
    }

    const orphanCount = await purgeOrphanedKbMedia(
      this.db,
      this.storage,
      orgId,
      new Date(),
      this.config.R2_KB_BUCKET_NAME,
    );
    if (orphanCount > 0)
      this.audit.log({
        action: "kb.media.orphan_purged",
        userId: "system",
        orgId,
        resourceType: "kb_page_attachment",
        metadata: { purgedCount: orphanCount },
      });

    if (purgedCount === 0) return 0;

    this.audit.log({
      action: "kb.page.auto_purged",
      systemActor: "kb.page.retention-sweep",
      orgId,
      resourceType: "kb_page",
      metadata: { purgedCount, olderThan: olderThan.toISOString() },
    });

    return purgedCount;
  }

  async getTrash(
    user: CurrentUserContext,
    query: TrashPagesQuery,
  ): Promise<CursorPage<KbPageListItem>> {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const position = decodeTimestampCursor(query.cursor);
    const filters: SQL[] = [
      eq(kbPages.orgId, orgId),
      isNotNull(kbPages.deletedAt),
      predicate,
    ];
    if (position)
      filters.push(keysetBeforeMicros(kbPages.deletedAt, kbPages.id, position));
    if (query.spaceId !== undefined)
      filters.push(eq(kbPages.spaceId, query.spaceId));
    if (query.deletedByMembershipId !== undefined)
      filters.push(
        eq(kbPages.deletedByMembershipId, query.deletedByMembershipId),
      );
    if (query.q) {
      const words = query.q
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((w) => w.length > 0)
        .slice(0, 8);
      if (words.length > 0) {
        const prefixQuery = words.map((w) => `${w}:*`).join(" & ");
        filters.push(
          sql`${kbPages}.fts @@ to_tsquery('english', ${prefixQuery})`,
        );
      }
    }
    const rows = await this.db
      .select({
        ...KB_PAGE_LIST_COLUMNS,
        deletedAtText: microsecondCursorValue(kbPages.deletedAt),
      })
      .from(kbPages)
      .where(and(...filters))
      .orderBy(desc(kbPages.deletedAt), desc(kbPages.id))
      .limit(query.limit + 1);
    return buildCursorPage(rows, query.limit, (row) => ({
      sortValue: row.deletedAtText ?? "",
      id: String(row.id),
    }));
  }

  async bulkRestore(
    user: CurrentUserContext,
    input: BulkPageIdsInput,
  ): Promise<{ results: BulkPageResult[] }> {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const found = await this.db
      .select({ id: kbPages.id, deletedAt: kbPages.deletedAt })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          inArray(kbPages.id, input.pageIds),
          predicate,
        ),
      );
    const foundMap = new Map(found.map((p) => [p.id, p.deletedAt]));
    const results: BulkPageResult[] = [];
    for (const pageId of input.pageIds) {
      if (!foundMap.has(pageId)) {
        results.push({ pageId, result: "notFound" });
        continue;
      }
      if (foundMap.get(pageId) === null) {
        results.push({ pageId, result: "succeeded" });
        continue;
      }
      try {
        await this.tree.restore(user, pageId);
      } catch (e) {
        if (e instanceof ConflictException) {
          results.push({ pageId, result: "succeeded" });
          continue;
        }
        throw e;
      }
      results.push({ pageId, result: "succeeded" });
    }
    return { results };
  }

  async bulkPurge(
    user: CurrentUserContext,
    input: BulkPageIdsInput,
  ): Promise<{ results: BulkPageResult[] }> {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const found = await this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          inArray(kbPages.id, input.pageIds),
          predicate,
        ),
      );
    const foundSet = new Set(found.map((p) => p.id));
    const results: BulkPageResult[] = [];
    for (const pageId of input.pageIds) {
      if (!foundSet.has(pageId)) {
        results.push({ pageId, result: "notFound" });
        continue;
      }
      try {
        await this.hardDelete(user, pageId);
      } catch (e) {
        if (e instanceof NotFoundException) {
          results.push({ pageId, result: "notFound" });
          continue;
        }
        throw e;
      }
      results.push({ pageId, result: "succeeded" });
    }
    return { results };
  }
}
