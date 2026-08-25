import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { kbArticles, kbPages, kbImportJobs } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { forEachOrg } from "../../../common/tenant/for-each-org";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { mapArticleToPage } from "./kb-article-migration.util";
import type {
  ArticleMigrationPreview,
  MigrationResult,
  RunArticleMigrationInput,
} from "./dto/kb-article-migration.schemas";

const BATCH_SIZE = 50;

export interface ArticleMigrationReport {
  organizations: Array<ArticleMigrationPreview & { orgId: string }>;
  failedOrganizations: number;
  totals: {
    organizations: number;
    total: number;
    alreadyMigrated: number;
    willMigrate: number;
  };
  retirementReady: boolean;
}

export function summarizeArticleMigrationReports(
  organizations: ArticleMigrationReport["organizations"],
  failedOrganizations = 0,
): Pick<ArticleMigrationReport, "totals" | "retirementReady"> {
  const totals = organizations.reduce(
    (result, report) => ({
      organizations: result.organizations + 1,
      total: result.total + report.total,
      alreadyMigrated: result.alreadyMigrated + report.alreadyMigrated,
      willMigrate: result.willMigrate + report.willMigrate,
    }),
    { organizations: 0, total: 0, alreadyMigrated: 0, willMigrate: 0 },
  );
  return { totals, retirementReady: failedOrganizations === 0 && totals.willMigrate === 0 };
}

@Injectable()
export class KbArticleMigrationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async preview(orgId: string): Promise<ArticleMigrationPreview> {
    return this.previewOn(this.db, orgId);
  }

  /**
   * Produces the c6 migration evidence for every active tenant. Discovery and
   * counting happen inside each tenant transaction so the report never relies
   * on a cross-tenant read that would bypass RLS.
   */
  async reportAll(): Promise<ArticleMigrationReport> {
    const organizations: ArticleMigrationReport["organizations"] = [];
    const sweep = await forEachOrg(this.db, "kb-article-migration-report", async (tx, orgId) => {
      organizations.push({ orgId, ...(await this.previewOn(tx, orgId)) });
    });

    return {
      organizations,
      failedOrganizations: sweep.failed,
      ...summarizeArticleMigrationReports(organizations, sweep.failed),
    };
  }

  private async previewOn(db: Db | TenantTx, orgId: string): Promise<ArticleMigrationPreview> {
    const byStatusRows = await db
      .select({ status: kbArticles.status, count: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(eq(kbArticles.orgId, orgId))
      .groupBy(kbArticles.status);

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of byStatusRows) {
      byStatus[row.status] = row.count;
      total += row.count;
    }

    const migratedRows = await db
      .select({ sourceArticleId: kbPages.sourceArticleId })
      .from(kbPages)
      .where(and(eq(kbPages.orgId, orgId), isNotNull(kbPages.sourceArticleId)));

    const migratedSet = new Set(
      migratedRows.map((r) => r.sourceArticleId).filter((v): v is number => v !== null),
    );

    const candidates = await db
      .select({ id: kbArticles.id, title: kbArticles.title, visibility: kbArticles.visibility })
      .from(kbArticles)
      .where(and(eq(kbArticles.orgId, orgId), eq(kbArticles.status, "published")));

    const notYetMigrated = candidates.filter((a) => !migratedSet.has(a.id));

    return {
      total,
      byStatus,
      alreadyMigrated: migratedSet.size,
      willMigrate: notYetMigrated.length,
      sample: notYetMigrated.slice(0, 10),
    };
  }

  async run(user: CurrentUserContext, input: RunArticleMigrationInput): Promise<MigrationResult> {
    const { orgId } = user;
    const { dryRun = false } = input;

    const migratedRows = await this.db
      .select({ sourceArticleId: kbPages.sourceArticleId })
      .from(kbPages)
      .where(and(eq(kbPages.orgId, orgId), isNotNull(kbPages.sourceArticleId)));

    const migratedSet = new Set(
      migratedRows.map((r) => r.sourceArticleId).filter((v): v is number => v !== null),
    );

    const articles = await this.db
      .select()
      .from(kbArticles)
      .where(and(eq(kbArticles.orgId, orgId), eq(kbArticles.status, "published")));

    const toMigrate = articles.filter((a) => !migratedSet.has(a.id));
    const skipped = articles.length - toMigrate.length;
    const total = articles.length;

    if (dryRun) {
      return { migrated: toMigrate.length, skipped, total, dryRun: true };
    }

    const [maxRow] = await this.db
      .select({ maxSort: max(kbPages.sortOrder) })
      .from(kbPages)
      .where(and(eq(kbPages.orgId, orgId), isNull(kbPages.parentPageId), isNull(kbPages.deletedAt)));

    const baseSort = (maxRow?.maxSort ?? 0) + 100;
    let migrated = 0;

    for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
      const batch = toMigrate.slice(i, i + BATCH_SIZE);
      const values = batch.map((article, j) => ({
        orgId,
        ...mapArticleToPage(article, baseSort + (i + j) * 100),
      }));

      try {
        await this.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(kbPages)
            .values(values)
            .onConflictDoNothing()
            .returning({ id: kbPages.id });
          migrated += inserted.length;
        });
      } catch {
        for (const article of batch) {
          try {
            const idx = toMigrate.indexOf(article);
            const [inserted] = await this.db
              .insert(kbPages)
              .values({ orgId, ...mapArticleToPage(article, baseSort + idx * 100) })
              .onConflictDoNothing()
              .returning({ id: kbPages.id });
            if (inserted) migrated++;
          } catch {
            // unrecoverable row (broken FK) — skip
          }
        }
      }
    }

    const [job] = await this.db
      .insert(kbImportJobs)
      .values({
        orgId,
        sourceType: "support_kb",
        status: "completed",
        totalItems: toMigrate.length,
        processedItems: toMigrate.length,
        succeededItems: migrated,
        failedItems: toMigrate.length - migrated,
        createdById: user.userId,
      })
      .returning();

    return { migrated, skipped, total, dryRun: false, jobId: job?.id };
  }
}
