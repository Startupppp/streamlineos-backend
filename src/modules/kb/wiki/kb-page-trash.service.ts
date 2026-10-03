import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CacheService } from "../../../common/cache/cache.service";
import {
  and,
  eq,
  inArray,
  isNotNull,
  lt,
  sql,
} from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type { BulkPageIdsInput } from "./dto/kb-pages.schemas";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { StorageService } from "../../storage/storage.service";
import {
  attemptPageAttachmentPurge,
  purgeOrphanedKbMedia,
  recordPageAttachmentPurge,
} from "./kb-page-attachment-purge";
import { APP_CONFIG } from "../../../config/config.module";
import type { AppConfig } from "../../../config/env.validation";
import { KbPageTreeService } from "./kb-page-tree.service";
import {
  incompleteStorePages,
  markStoresComplete,
  markStoresFailed,
  openMultiStoreLedger,
  type KbPurgeStore,
  purgeFavoritesForPages,
  purgeLinksForPages,
  purgeVisitsForPages,
  purgeVersionsForPages,
  purgeCommentsForPages,
  purgeGrantsForPages,
  purgeChunksForPages,
  purgeAnalyticsForPages,
  purgeNotificationsForPages,
  purgeCachesForPages,
  purgePublicCdnForPages,
  purgeConnectorProjectionsForPages,
} from "./kb-multi-store-purge";
import { purgeReviewsForPages } from "./kb-purge-reviews";
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
    private readonly cache: CacheService,
  ) {}

  private async assertNoLegalHoldInSubtree(
    orgId: string,
    subtreeIds: number[],
  ): Promise<void> {
    if (subtreeIds.length === 0) return;

    const held = await this.db
      .select({
        id: kbPages.id,
        title: kbPages.title,
        legalHoldReason: kbPages.legalHoldReason,
      })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          inArray(kbPages.id, subtreeIds),
          eq(kbPages.legalHold, true),
        ),
      );

    if (held.length === 0) return;

    const named = held
      .map((row) => {
        const reason = row.legalHoldReason ? `: ${row.legalHoldReason}` : "";
        return `"${row.title}"${reason}`;
      })
      .join(", ");

    throw new ConflictException(
      `This page cannot be permanently deleted because ${held.length} page(s) beneath it are under a legal hold — ${named}.`,
    );
  }

  async hardDelete(user: CurrentUserContext, pageId: number): Promise<void> {
    const orgId = user.orgId;
    const predicate = await this.auth.visiblePagePredicate(user, "view");
    const page = await this.db.query.kbPages.findFirst({
      where: and(eq(kbPages.id, pageId), eq(kbPages.orgId, orgId), predicate),
      columns: { id: true, title: true, legalHold: true, legalHoldReason: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    if (page.legalHold) {
      const reason = page.legalHoldReason
        ? `: ${page.legalHoldReason}`
        : "";
      throw new ConflictException(
        `This page is under a legal hold${reason} and cannot be permanently deleted.`,
      );
    }

    const subtreeIds = await this.db.transaction((tx) =>
      collectSubtreeIds(tx, orgId, pageId),
    );

    await this.assertNoLegalHoldInSubtree(orgId, subtreeIds);

    await openMultiStoreLedger(this.db, orgId, subtreeIds);
    const purgeKeys = await recordPageAttachmentPurge(
      this.db,
      orgId,
      subtreeIds,
    );

    await this.executePreDeleteStores(orgId, subtreeIds);

    await this.db.transaction(async (tx) => {
      const heldNow = await tx
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            inArray(kbPages.id, subtreeIds),
            eq(kbPages.legalHold, true),
          ),
        )
        .for("update");

      if (heldNow.length > 0) {
        throw new ConflictException(
          `A legal hold was placed on ${heldNow.length} page(s) in this subtree while the deletion was in progress; nothing was removed from the page table.`,
        );
      }

      await tx.delete(kbPages).where(
        and(
          eq(kbPages.orgId, orgId),
          eq(kbPages.legalHold, false),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            subtreeIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
    });

    await markStoresComplete(this.db, orgId, subtreeIds, "page_rows").catch(
      () => undefined,
    );

    await attemptPageAttachmentPurge(
      this.db,
      this.storage,
      orgId,
      purgeKeys,
      this.config.R2_KB_BUCKET_NAME,
    );

    await markStoresComplete(this.db, orgId, subtreeIds, "blobs").catch(
      () => undefined,
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

  private async executePreDeleteStores(
    orgId: string,
    subtreeIds: number[],
  ): Promise<void> {
    const stores: {
      store: KbPurgeStore;
      purge: (pageIds: number[]) => Promise<void>;
    }[] = [
      {
        store: "visits",
        purge: (pageIds) => purgeVisitsForPages(this.db, orgId, pageIds),
      },
      {
        store: "favorites",
        purge: (pageIds) => purgeFavoritesForPages(this.db, orgId, pageIds),
      },
      {
        store: "source_links",
        purge: (pageIds) => purgeLinksForPages(this.db, orgId, pageIds),
      },
      {
        store: "reviews",
        purge: (pageIds) => purgeReviewsForPages(this.db, orgId, pageIds),
      },
      {
        store: "versions",
        purge: (pageIds) => purgeVersionsForPages(this.db, orgId, pageIds),
      },
      {
        store: "comments",
        purge: (pageIds) => purgeCommentsForPages(this.db, orgId, pageIds),
      },
      {
        store: "grants",
        purge: (pageIds) => purgeGrantsForPages(this.db, orgId, pageIds),
      },
      {
        store: "chunks",
        purge: (pageIds) => purgeChunksForPages(this.db, orgId, pageIds),
      },
      {
        store: "analytics",
        purge: (pageIds) => purgeAnalyticsForPages(this.db, orgId, pageIds),
      },
      {
        store: "notifications",
        purge: (pageIds) => purgeNotificationsForPages(this.db, orgId, pageIds),
      },
      {
        store: "caches",
        purge: (pageIds) => purgeCachesForPages(this.cache, orgId, pageIds),
      },
      {
        store: "public_cdn",
        purge: (pageIds) => purgePublicCdnForPages(this.db, orgId, pageIds),
      },
      {
        store: "connector_projections",
        purge: (pageIds) =>
          purgeConnectorProjectionsForPages(this.db, orgId, pageIds),
      },
    ];
    for (const { store, purge } of stores) {
      const pending = await incompleteStorePages(
        this.db,
        orgId,
        subtreeIds,
        store,
      );
      if (pending.length === 0) continue;
      try {
        await purge(pending);
        await markStoresComplete(this.db, orgId, pending, store);
      } catch (err) {
        await markStoresFailed(
          this.db,
          orgId,
          pending,
          store,
          String(err),
        ).catch(() => undefined);
        throw err;
      }
    }
  }

  async emptyTrash(user: CurrentUserContext): Promise<{ purgedCount: number }> {
    const orgId = user.orgId;
    let purgedCount = 0;

    for (;;) {
      const trashed = await this.db
        .select({ id: kbPages.id })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            isNotNull(kbPages.deletedAt),
            eq(kbPages.legalHold, false),
          ),
        )
        .orderBy(kbPages.id)
        .limit(EXPIRED_PURGE_BATCH_SIZE);

      if (trashed.length === 0) break;

      const ids = trashed.map((p) => p.id);
      await openMultiStoreLedger(this.db, orgId, ids);
      const purgeKeys = await recordPageAttachmentPurge(this.db, orgId, ids);
      await this.executePreDeleteStores(orgId, ids);

      const deleted = await this.db
        .delete(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.legalHold, false),
            inArray(kbPages.id, ids),
          ),
        )
        .returning({ id: kbPages.id });

      await markStoresComplete(this.db, orgId, ids, "page_rows").catch(
        () => undefined,
      );

      await attemptPageAttachmentPurge(
        this.db,
        this.storage,
        orgId,
        purgeKeys,
        this.config.R2_KB_BUCKET_NAME,
      );

      await markStoresComplete(this.db, orgId, ids, "blobs").catch(
        () => undefined,
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
            eq(kbPages.legalHold, false),
          ),
        )
        .orderBy(kbPages.id)
        .limit(EXPIRED_PURGE_BATCH_SIZE);

      if (expired.length === 0) break;

      const ids = expired.map((p) => p.id);
      await openMultiStoreLedger(this.db, orgId, ids);
      const purgeKeys = await recordPageAttachmentPurge(this.db, orgId, ids);
      await this.executePreDeleteStores(orgId, ids);
      await this.db.delete(kbPages).where(
        and(
          eq(kbPages.orgId, orgId),
          sql`${kbPages.id} = ANY(ARRAY[${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )}]::int[])`,
        ),
      );
      await markStoresComplete(this.db, orgId, ids, "page_rows").catch(
        () => undefined,
      );
      await attemptPageAttachmentPurge(
        this.db,
        this.storage,
        orgId,
        purgeKeys,
        this.config.R2_KB_BUCKET_NAME,
      );
      await markStoresComplete(this.db, orgId, ids, "blobs").catch(
        () => undefined,
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
    const results: BulkPageResult[] = input.pageIds.map((pageId) => ({
      pageId,
      result: foundMap.has(pageId) ? ("succeeded" as const) : ("notFound" as const),
    }));
    const deletedIds = input.pageIds.filter(
      (pageId) => foundMap.has(pageId) && foundMap.get(pageId) !== null,
    );
    if (deletedIds.length > 0) await this.tree.restoreMany(user, deletedIds);
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
    const visibleIds = input.pageIds.filter((id) => foundSet.has(id));

    const results: BulkPageResult[] = input.pageIds.map((pageId) => ({
      pageId,
      result: foundSet.has(pageId) ? ("succeeded" as const) : ("notFound" as const),
    }));

    if (visibleIds.length === 0) return { results };

    const subtreeIds = await this.db.transaction((tx) =>
      collectSubtreeIds(tx, orgId, visibleIds),
    );

    if (subtreeIds.length === 0) return { results };

    try {
      await this.assertNoLegalHoldInSubtree(orgId, subtreeIds);
    } catch (e) {
      if (e instanceof ConflictException) {
        for (const r of results) {
          if (r.result === "succeeded") r.result = "conflict";
        }
        return { results };
      }
      throw e;
    }

    await openMultiStoreLedger(this.db, orgId, subtreeIds);
    const purgeKeys = await recordPageAttachmentPurge(
      this.db,
      orgId,
      subtreeIds,
    );
    await this.executePreDeleteStores(orgId, subtreeIds);

    try {
      await this.db.transaction(async (tx) => {
        const heldNow = await tx
          .select({ id: kbPages.id })
          .from(kbPages)
          .where(
            and(
              eq(kbPages.orgId, orgId),
              inArray(kbPages.id, subtreeIds),
              eq(kbPages.legalHold, true),
            ),
          )
          .for("update");

        if (heldNow.length > 0) {
          throw new ConflictException(
            `A legal hold was placed on ${heldNow.length} page(s) in this subtree while the deletion was in progress; nothing was removed from the page table.`,
          );
        }

        await tx.delete(kbPages).where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.legalHold, false),
            inArray(kbPages.id, subtreeIds),
          ),
        );
      });
    } catch (e) {
      if (e instanceof ConflictException) {
        for (const r of results) {
          if (r.result === "succeeded") r.result = "conflict";
        }
        return { results };
      }
      throw e;
    }

    await markStoresComplete(this.db, orgId, subtreeIds, "page_rows").catch(
      () => undefined,
    );

    await attemptPageAttachmentPurge(
      this.db,
      this.storage,
      orgId,
      purgeKeys,
      this.config.R2_KB_BUCKET_NAME,
    );

    await markStoresComplete(this.db, orgId, subtreeIds, "blobs").catch(
      () => undefined,
    );

    this.audit.log({
      action: "kb.page.permanently_deleted",
      userId: user.userId,
      orgId,
      resourceType: "kb_page",
      metadata: { count: visibleIds.length },
    });

    return { results };
  }
}
