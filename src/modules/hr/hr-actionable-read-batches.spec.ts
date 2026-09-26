import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("HR actionable read batches", () => {
  const sourceRoot = resolve(__dirname);
  const read = (relativePath: string) => readFileSync(resolve(sourceRoot, relativePath), "utf8");

  it("rolls back import rows with a complete ascending cursor batch", () => {
    const source = read("import/hr-import.service.ts");

    expect(source).toMatch(/const IMPORT_ROW_BATCH_SIZE = 500/);
    expect(source.match(/\.limit\(IMPORT_ROW_BATCH_SIZE\)/g)).toHaveLength(1);
    expect(source.match(/orderBy\(asc\(hrImportRows\.id\)\)/g)).toHaveLength(1);
    expect(source.match(/gt\(hrImportRows\.id, afterId\)/g)).toHaveLength(1);
  });

  it("commits import rows manager-first in bounded batches of ids (HRM-15)", () => {
    const service = read("import/hr-import.service.ts");
    const order = read("import/hr-import-employee-managers.ts");

    expect(service).toMatch(/readImportRowsInOrder\(tx, jobId, order\.slice\(start, start \+ IMPORT_ROW_BATCH_SIZE\)\)/);
    expect(order).toMatch(/\.limit\(IMPORT_ROW_CAP\)/);
    expect(order).toMatch(/\.limit\(ids\.length\)/);
  });

  it("keeps booking notification lookups explicitly single-row and tenant-scoped", () => {
    const source = read("interviews/hr-interview-booking.service.ts");

    expect(source.match(/\.limit\(1\)/g)).toHaveLength(2);
    expect(source).toMatch(/eq\(candidates\.orgId, orgId\)/);
  });

  it("aggregates scorecards from complete bounded ID batches", () => {
    const source = read("interviews/hr-scorecards.service.ts");

    expect(source).toMatch(/const SCORECARD_ANALYTICS_BATCH_SIZE = 500/);
    expect(source).toMatch(/gt\(interviewScorecards\.id, afterId\)/);
    expect(source).toMatch(/orderBy\(asc\(interviewScorecards\.id\)\)/);
    expect(source).toMatch(/\.limit\(SCORECARD_ANALYTICS_BATCH_SIZE\)/);
    expect(source).toMatch(/afterId = rows\[rows\.length - 1\]!\.id/);
  });
});
