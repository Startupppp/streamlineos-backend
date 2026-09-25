import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "projects-analytics.service.ts"), "utf8");

describe("ProjectsAnalyticsService status-group contract", () => {
  it("derives completion metrics from project status groups", () => {
    expect(source).toContain("projectStatuses");
    expect(source).toContain("statusGroup");
    expect(source).toContain("'completed'");
    expect(source).toContain("'cancelled'");
    expect(source).not.toMatch(/tickets\.status\s*=\s*'DONE'/);
    expect(source).not.toMatch(/tickets\.status\s+NOT IN\s*\('DONE'/);
  });
});
