import { summarizeArticleMigrationReports } from "./kb-article-migration.service";

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
