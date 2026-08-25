import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, count, eq, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
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
}

const DEFAULT_DELAY_MS = 100;

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

  private async findEligibleUnindexedPages(orgId: string): Promise<Array<{ id: number }>> {
    return this.db
      .select({ id: kbPages.id })
      .from(kbPages)
      .where(
        and(
          eq(kbPages.orgId, orgId),
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
      .orderBy(asc(kbPages.id));
  }

  private async countPageBodyChunks(orgId: string): Promise<number> {
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
    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;

    let pages: Array<{ id: number }> = [];
    let before = 0;

    await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
        [pages, before] = await Promise.all([
          this.findEligibleUnindexedPages(orgId),
          this.countPageBodyChunks(orgId),
        ]);
      }),
    );

    if (pages.length === 0) {
      return { orgId, before, after: before, indexed: 0, failed: 0 };
    }

    let indexed = 0;
    let failed = 0;

    for (const page of pages) {
      try {
        await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
          runWithTenantContext({ orgId, audience: "INTERNAL", tx }, () =>
            this.indexing.indexPage(orgId, page.id),
          ),
        );
        indexed += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `[kb-page-backfill] page ${String(page.id)} org ${orgId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (delayMs > 0) await pause(delayMs);
    }

    let after = 0;
    await withTenant(this.db, { orgId, audience: "INTERNAL" }, (tx) =>
      runWithTenantContext({ orgId, audience: "INTERNAL", tx }, async () => {
        after = await this.countPageBodyChunks(orgId);
      }),
    );

    return { orgId, before, after, indexed, failed };
  }

  async backfillAll(options: BackfillOptions = {}): Promise<BackfillAllResult> {
    const orgs = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(isNull(organizations.deletedAt), eq(organizations.status, "ACTIVE")))
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
