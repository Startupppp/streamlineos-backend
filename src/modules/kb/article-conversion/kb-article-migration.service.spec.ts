import {
  summarizeArticleMigrationReports,
  unresolvedArticleIds,
} from "./kb-article-migration.service";
import { runArticleMigrationSchema } from "./dto/kb-article-migration.schemas";

describe("summarizeArticleMigrationReports", () => {
  it("aggregates tenant counts and stays open while any article is unmigrated", () => {
    const result = summarizeArticleMigrationReports([
      {
        orgId: "org-a",
        total: 4,
        byStatus: { published: 4 },
        alreadyMigrated: 3,
        willMigrate: 1,
        sample: [],
      },
      {
        orgId: "org-b",
        total: 2,
        byStatus: { published: 2 },
        alreadyMigrated: 2,
        willMigrate: 0,
        sample: [],
      },
    ]);

    expect(result).toEqual({
      totals: { organizations: 2, total: 6, alreadyMigrated: 5, willMigrate: 1 },
      retirementReady: false,
    });
  });

  it("marks the conversion tool safe to retire only when every tenant is drained", () => {
    expect(
      summarizeArticleMigrationReports([
        {
          orgId: "org-a",
          total: 2,
          byStatus: { published: 2 },
          alreadyMigrated: 2,
          willMigrate: 0,
          sample: [],
        },
      ]).retirementReady,
    ).toBe(true);
  });

  it("never reports retirement readiness when a tenant sweep fails", () => {
    const reports = [{
      orgId: "org-a",
      total: 0,
      byStatus: {},
      alreadyMigrated: 0,
      willMigrate: 0,
      sample: [],
    }];

    expect(summarizeArticleMigrationReports(reports, 1).retirementReady).toBe(false);
  });
});

describe("runArticleMigrationSchema", () => {
  it("defaults callers to dry-run", () => {
    expect(runArticleMigrationSchema.parse({})).toEqual({ dryRun: true });
    expect(runArticleMigrationSchema.safeParse({ dryRun: true }).success).toBe(true);
  });

  it("requires an exact confirmation phrase before conversion writes", () => {
    expect(runArticleMigrationSchema.safeParse({ dryRun: false }).success).toBe(false);
    expect(
      runArticleMigrationSchema.safeParse({
        dryRun: false,
        confirmation: "CONVERT_PUBLISHED_ARTICLES",
      }).success,
    ).toBe(true);
  });
});

describe("unresolvedArticleIds", () => {
  it("reports only candidates absent from durable page mappings", () => {
    expect(unresolvedArticleIds([10, 20, 30], new Set([10, 30, 99]))).toEqual([20]);
  });

  it("does not report an on-conflict race once its mapping is visible", () => {
    expect(unresolvedArticleIds([7], new Set([7]))).toEqual([]);
  });
});
