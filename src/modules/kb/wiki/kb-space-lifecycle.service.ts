import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  kbSpaces,
  kbPages,
  kbPageLinks,
  kbSources,
} from "../../../db/schema";
import {
  supportArticlePredicate,
  wikiContentTypeOnly,
} from "../help-centre/kb-article-page-scope";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { TenantTx } from "../../../db/drizzle.types";
import { KnowledgeAuthorizationService } from "../core/authorization/knowledge-authorization.service";
import { randomUUID } from "node:crypto";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";

export interface SpaceArchiveImpact {
  pageCount: number;
  publicLinkCount: number;
  recordLinkCount: number;
  askIndexed: boolean;
}

const SPACE_CONTENT_BATCH_SIZE = 500;

@Injectable()
export class KbSpaceLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly authz: KnowledgeAuthorizationService,
  ) {}

  async archive(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");

    await this.db
      .update(kbSpaces)
      .set({ archivedAt: new Date() })
      .where(
        and(
          eq(kbSpaces.id, spaceId),
          eq(kbSpaces.orgId, orgId),
          isNull(kbSpaces.archivedAt),
        ),
      );

    return { success: true };
  }

  async restore(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");

    await this.db
      .update(kbSpaces)
      .set({ archivedAt: null })
      .where(and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, orgId)));

    return { success: true };
  }

  async archiveImpact(
    orgId: string,
    spaceId: number,
  ): Promise<SpaceArchiveImpact> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");

    const [pageResult, publicResult, recordResult, indexedResult] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPages)
        .where(
          and(
            eq(kbPages.orgId, orgId),
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
            isNotNull(kbPages.publicToken),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbPageLinks)
        .innerJoin(
          kbPages,
          and(
            eq(kbPageLinks.orgId, orgId),
            eq(kbPageLinks.sourcePageId, kbPages.id),
          ),
        )
        .where(
          and(
            eq(kbPages.spaceId, spaceId),
            isNull(kbPages.deletedAt),
            isNotNull(kbPageLinks.targetId),
          ),
        ),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbSources)
        .where(
          and(
            eq(kbSources.orgId, orgId),
            eq(kbSources.spaceId, spaceId),
            gt(kbSources.chunkCount, 0),
            isNull(kbSources.deletedAt),
          ),
        ),
    ]);

    const pageCount = pageResult[0]?.count ?? 0;
    const publicLinkCount = publicResult[0]?.count ?? 0;
    const recordLinkCount = recordResult[0]?.count ?? 0;
    const askIndexed = (indexedResult[0]?.count ?? 0) > 0;

    return {
      pageCount,
      publicLinkCount,
      recordLinkCount,
      askIndexed,
    };
  }

  async remove(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [deleted] = await tx
          .update(kbSpaces)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(kbSpaces.id, spaceId),
              eq(kbSpaces.orgId, orgId),
              isNull(kbSpaces.deletedAt),
            ),
          )
          .returning({ id: kbSpaces.id });
        if (!deleted) throw new NotFoundException("Space not found");

        await this.emitContentDeletes(tx, orgId, "article", (afterId) =>
          tx
            .select({ id: kbPages.id })
            .from(kbPages)
            .where(
              and(
                eq(kbPages.orgId, orgId),
                eq(kbPages.spaceId, spaceId),
                supportArticlePredicate(),
                gt(kbPages.id, afterId),
              ),
            )
            .orderBy(asc(kbPages.id))
            .limit(SPACE_CONTENT_BATCH_SIZE),
        );
        await this.emitContentDeletes(tx, orgId, "page", (afterId) =>
          tx
            .select({ id: kbPages.id })
            .from(kbPages)
            .where(
              and(
                eq(kbPages.orgId, orgId),
                eq(kbPages.spaceId, spaceId),
                wikiContentTypeOnly(),
                gt(kbPages.id, afterId),
              ),
            )
            .orderBy(asc(kbPages.id))
            .limit(SPACE_CONTENT_BATCH_SIZE),
        );
      },
      { orgId },
    );
    await this.authz.invalidateSpaceScope(orgId);
    return { success: true };
  }

  private async emitContentDeletes(
    tx: TenantTx,
    orgId: string,
    contentType: "article" | "page",
    nextBatch: (afterId: number) => Promise<{ id: number }[]>,
  ): Promise<void> {
    const aggregateType = contentType === "article" ? "kb_article" : "kb_page";
    let afterId = 0;
    for (;;) {
      const rows = await nextBatch(afterId);
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      afterId = last.id;

      const occurredAt = new Date();
      await OutboxWriter.emitMany(
        tx,
        rows.map((row) => ({
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType,
          aggregateId: String(row.id),
          aggregateVersion: occurredAt.getTime(),
          eventType: "kb.content.delete",
          payload: { contentType, contentId: row.id },
          occurredAt,
        })),
      );

      if (rows.length < SPACE_CONTENT_BATCH_SIZE) break;
    }
  }
}
