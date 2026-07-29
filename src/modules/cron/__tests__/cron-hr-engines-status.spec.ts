import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(__dirname, "../cron-hr-engines.service.ts"),
  "utf8",
);

describe("CronHrEnginesService.listOrgIds — active-org filter excludes purged orgs", () => {
  it("filters org candidates using the status column that the purge worker writes", () => {
    expect(source).toContain('eq(organizations.status, "ACTIVE")');
  });

  it("does not reference statusV2 for the active-org list (statusV2 may be NULL on pre-migration rows)", () => {
    const listOrgIdsBlock = source.slice(
      source.indexOf("private async listOrgIds"),
      source.indexOf("async sweepWorkflowSlaEscalations"),
    );
    expect(listOrgIdsBlock).not.toContain("statusV2");
  });

  it("also guards against soft-deleted orgs via deletedAt", () => {
    const listOrgIdsBlock = source.slice(
      source.indexOf("private async listOrgIds"),
      source.indexOf("async sweepWorkflowSlaEscalations"),
    );
    expect(listOrgIdsBlock).toContain("deletedAt");
  });
});
