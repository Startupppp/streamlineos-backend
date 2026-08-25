import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, count, eq, gt, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import { organizations, kbPages, kbArticleChunks } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { withTenant } from "../../../common/tenant/with-tenant";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import { KbIndexingService } from "./kb-indexing.service";

export interface OrgBackfillResult {
  orgId: string;
  before: number;
  after: number;
  indexed: number;
  failed: number;
  scanned: number;
  nextPageId: number | null;
}

export interface BackfillAllResult {
  organizations: number;
  processed: number;
  skipped: number;
  totalBefore: number;
  totalAfter: number;
  totalIndexed: number;
  totalFailed: number;
  details: OrgBackfillResult[];
}

export interface BackfillOptions {
  delayMs?: number;
  batchSize?: number;
  afterPageId?: number;
  maxPages?: number;
  orgId?: string;
}

const DEFAULT_DELAY_MS = 100;
const DEFAULT_BATCH_SIZE = 50;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class KbPageBackfillService {
  private readonly logger = new Logger(KbPageBackfillService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly indexing: KbIndexingService,
  ) {}

  async findEligibleUnindexedPages(
    orgId: string,
    afterPageId = 0,
    limit = DEFAULT_BATCH_SIZE,
  ): Promise<Array<{ id: number }>> {
    return this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
          gt(kbPages.id, afterPageId),
          ne(kbPages.status, "archived"),
          isNull(kbPages.deletedAt),
          isNotNull(kbPages.contentText),
          sql`trim(${kbPages.contentText}) != ''`,
          notExists(
            this.db
              .select({ one: sql<number>`1` })
              .from(kbArticleChunks)
              .where(
                and(
                  eq(kbArticleChunks.orgId, orgId),
                  eq(kbArticleChunks.pageId, kbPages.id),
                  eq(kbArticleChunks.source, "page_body"),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(kbPages.id))
      .limit(limit);
  }

  async countPageBodyChunks(orgId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(kbArticleChunks)
      .where(
        and(
          eq(kbArticleChunks.orgId, orgId),
          eq(kbArticleChunks.source, "page_body"),
        ),
      );
    return row?.n ?? 0;
  }

  async backfillOrg(orgId: string, options: BackfillOptions = {}): Promise<OrgBackfillResult> {
    const delayMs = Number.isFinite(options.delayMs)
      ? Math.max(0, Math.floor(options.delayMs ?? DEFAULT_DELAY_MS))
      : DEFAULT_DELAY_MS;
    const batchSize = Number.isFinite(options.batchSize)
      ? Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE))
      : DEFAULT_BATCH_SIZE;
    const maxPages = options.maxPages === undefined
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(options.maxPages)
        ? Math.max(0, Math.floor(options.maxPages))
        : Number.POSITIVE_INFINITY;
    let before = 0;

    await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
        before = await this.countPageBodyChunks(orgId);
      }),
    );

    let indexed = 0;
    let failed = 0;
    let scanned = 0;
    let cursor = Math.max(0, Math.floor(options.afterPageId ?? 0));
    let resumeCursor: number | null = null;
    let attempted = 0;

    while (scanned < maxPages) {
      const remaining = maxPages - scanned;
      const requested = Math.min(batchSize, remaining);
      const discovered = await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
        runWithTenantContext({ orgId, audience: "INTERNAL", tx }, () =>
          this.findEligibleUnindexedPages(orgId, cursor, requested),
        ),
      );
      // Keep the bound true even if a test double or a future adapter returns
      // more rows than requested.
      const pages = discovered.slice(0, requested);

      if (pages.length === 0) break;

      for (const page of pages) {
        // Delay between attempts, including after a failed attempt, so a
        // transient embedding failure cannot turn the next page into a burst.
        if (attempted > 0 && delayMs > 0) await pause(delayMs);
        attempted += 1;
        scanned += 1;
        try {
          await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
            runWithTenantContext({ orgId, audience: "INTERNAL", tx }, () =>
              this.indexing.indexPage(orgId, page.id),
            ),
          );
          indexed += 1;
          cursor = page.id;
        } catch (err) {
          failed += 1;
          // `cursor` is the last successful page, not the failed page. The
          // discovery query is strict-greater-than, so retaining this cursor
          // makes the failed page the first candidate on the next run.
          resumeCursor ??= cursor;
          this.logger.error(
            `[kb-page-backfill] page ${String(page.id)} org ${orgId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (scanned >= maxPages) break;
      }

      // Finish the current batch so independent pages still make progress, but
      // return the cursor before the first failure for a resumable retry.
      if (resumeCursor !== null || pages.length < requested) break;
    }

    let after = 0;
    await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
        after = await this.countPageBodyChunks(orgId);
      }),
    );

    return {
      orgId,
      before,
      after,
      indexed,
      failed,
      scanned,
      nextPageId:
        resumeCursor ?? (scanned >= maxPages ? cursor : null),
    };
  }

  async backfillAll(options: BackfillOptions = {}): Promise<BackfillAllResult> {
    const orgFilters = [
      isNull(organizations.deletedAt),
      eq(organizations.status, "ACTIVE"),
    ];
    if (options.orgId) orgFilters.push(eq(organizations.id, options.orgId));

    const orgs = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(...orgFilters))
      .orderBy(asc(organizations.id));

    const details: OrgBackfillResult[] = [];
    let skipped = 0;

    for (const org of orgs) {
      let result: OrgBackfillResult;
      try {
        result = await this.backfillOrg(org.id, options);
      } catch (err) {
        this.logger.error(
          `[kb-page-backfill] org ${org.id} fatal: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (result.indexed === 0 && result.failed === 0) {
        skipped += 1;
      } else {
        details.push(result);
      }
    }

    return {
      organizations: orgs.length,
      processed: details.length,
      skipped,
      totalBefore: details.reduce((sum, r) => sum + r.before, 0),
      totalAfter: details.reduce((sum, r) => sum + r.after, 0),
      totalIndexed: details.reduce((sum, r) => sum + r.indexed, 0),
      totalFailed: details.reduce((sum, r) => sum + r.failed, 0),
      details,
    };
  }
}
