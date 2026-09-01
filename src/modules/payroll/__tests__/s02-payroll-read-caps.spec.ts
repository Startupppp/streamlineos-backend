import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("S02 Payroll collection read caps", () => {
  const sourceRoot = resolve(__dirname, "../..");
  const cappedQueries: Array<[string, string]> = [
    ["hr/payroll-inputs/payroll-input-snapshots.service.ts", ".select({"],
    ["hr/payroll-inputs/payroll-inputs-build.service.ts", ".select({"],
    ["payroll/insights/journal.service.ts", ".select({"],
    ["payroll/insights/journal-outbox.service.ts", ".select(journalBatchLineSelection)"],
    ["payroll/runs/loan-recovery.service.ts", ".select({ calculationSnapshot:"],
    ["payroll/runs/payroll-run-variance.service.ts", ".select({ userId:"],
    ["payroll/runs/run-data-loader.service.ts", "id: employeeSalaryProfiles.id"],
    ["payroll/runs/salary-profiles.repository.ts", "id: employeeSalaryProfileComponents.id"],
  ];

  it.each(cappedQueries)("keeps %s bounded near %s", (relativePath, anchor) => {
    const source = readFileSync(resolve(sourceRoot, relativePath), "utf8");
    const start = source.indexOf(anchor);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 1200)).toMatch(/\.limit\((100|1000)\)/);
  });
});
