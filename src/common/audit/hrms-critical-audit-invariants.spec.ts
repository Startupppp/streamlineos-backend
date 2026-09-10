import { join } from "node:path";
import {
  awaitedAuditWrites,
  scanServiceAuditAwaits,
  totalAuditWrites,
} from "../../../test/security/audit-await-scan";

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
      const report = scanServiceAuditAwaits(join(SRC_ROOT, relativePath));
      expect(totalAuditWrites(report)).toBeGreaterThan(0);
      expect(awaitedAuditWrites(report)).toBe(totalAuditWrites(report));
      expect(report.bestEffortLog).toBe(false);
    },
  );
});
