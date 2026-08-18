import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname, "../..");

const HRMS_MUTATION_SERVICES = [
  "modules/directory/directory.service.ts",
  "modules/directory/worker-engagements.service.ts",
  "modules/hr/directory/employee-bulk-onboarding.service.ts",
  "modules/hr/directory/employee-mutations.service.ts",
  "modules/hr/directory/employee-onboarding.service.ts",
  "modules/hr/lifecycle/termination.service.ts",
  "modules/hr/performance/documents.service.ts",
  "modules/hr/time/leaves-approval.service.ts",
  "modules/hr/time/leaves-write.service.ts",
  "modules/hr/time/work-logs.service.ts",
  "modules/organization/hierarchy/org-hierarchy-branches.service.ts",
  "modules/organization/hierarchy/org-hierarchy-business-units.service.ts",
  "modules/organization/hierarchy/org-hierarchy-cost-centers.service.ts",
  "modules/organization/hierarchy/org-hierarchy-departments.service.ts",
  "modules/organization/hierarchy/org-hierarchy-locations.service.ts",
  "modules/organization/hierarchy/org-hierarchy-teams.service.ts",
] as const;

describe("HRMS critical audit boundaries", () => {
  it.each(HRMS_MUTATION_SERVICES)(
    "awaits durable audit writes in %s",
    (relativePath) => {
      const source = readFileSync(join(SRC_ROOT, relativePath), "utf8");
      const criticalCalls = source.match(/this\.audit\.logCritical\(/g) ?? [];
      const awaitedCalls = source.match(/await this\.audit\.logCritical\(/g) ?? [];
      expect(criticalCalls.length).toBeGreaterThan(0);
      expect(awaitedCalls).toHaveLength(criticalCalls.length);
      expect(source).not.toMatch(/\bthis\.audit\.log\(/);
    },
  );
});
