/**
 * audit-attribution.spec.ts
 *
 * Static verification of audit log coverage and attribution completeness.
 *
 * Extends the pattern from hrms-critical-audit-invariants.spec.ts to cover
 * additional high-risk mutation surfaces and verify schema gaps are documented.
 *
 * Schema gaps found and documented (verified against audit-logs.ts):
 *   G1 — No top-level `requestId` / `correlationId` column; stored in metadata.requestId only.
 *   G2 — actorMembershipId IS NOW PRESENT (integer FK to organization_members). CLOSED.
 *   G3 — No `reason` column; stored in metadata when present.
 *   G4 — No `principalType` column (user, agent-token, delegation); absent.
 *
 * Remaining gaps (G1, G3, G4) do not cause incorrect auditing today, but they prevent
 * efficient querying and may cause compliance gaps under DPDP/SOC2 audit requirements.
 *
 * Suite: run with  node ./node_modules/jest/bin/jest.js test/security/audit-attribution.spec.ts
 *   Requires WIRING: "roots" in jest config must include "<rootDir>/test".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  awaitedAuditWrites,
  scanServiceAuditAwaits,
  totalAuditWrites,
} from "./audit-await-scan";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

describe("audit_logs schema — columns present", () => {
  const schemaSrc = src("src/db/schema/common/audit-logs.ts");

  const expectedColumns = [
    "action",
    "user_id",
    "org_id",
    "target_id",
    "target_type",
    "actor_user_id",
    "resource_type",
    "resource_id",
    "metadata",
    "ip_address",
    "is_platform_event",
    "created_at",
  ];

  it.each(expectedColumns)("column present: %s", (col) => {
    expect(schemaSrc).toContain(`"${col}"`);
  });
});

describe("audit_logs schema — documented gaps", () => {
  const schemaSrc = src("src/db/schema/common/audit-logs.ts");

  it("G1 — no top-level requestId column (stored in metadata only)", () => {
    const hasRequestIdColumn =
      schemaSrc.includes('"request_id"') || schemaSrc.includes("requestId:");
    expect(hasRequestIdColumn).toBe(false);
  });

  it("G2 CLOSED — actorMembershipId is present (FK to organization_members)", () => {
    expect(schemaSrc).toMatch(/actor_membership_id|actorMembershipId/);
  });

  it("G3 — no reason column", () => {
    expect(schemaSrc).not.toMatch(/"reason"/);
  });

  it("G4 — no principalType column", () => {
    expect(schemaSrc).not.toMatch(/principal_type|principalType/);
  });
});

describe("AuditService — logCritical is awaited", () => {
  const auditSrc = src("src/common/audit/audit.service.ts");

  it("logCritical is async and propagates failures", () => {
    expect(auditSrc).toMatch(/async logCritical/);
    expect(auditSrc).toMatch(/await this\.write/);
  });

  it("log() is best-effort (swallows errors via .catch)", () => {
    expect(auditSrc).toMatch(/\.catch\s*\(/);
    const logMethodStart = auditSrc.indexOf("log(entry");
    const logMethodSection = auditSrc.slice(logMethodStart, logMethodStart + 500);
    expect(logMethodSection).toMatch(/\.catch/);
  });
});

const MUTATION_SERVICES_WITH_CRITICAL_AUDIT = [
  "modules/hr/directory/employee-mutations.service.ts",
  "modules/hr/directory/employee-onboarding.service.ts",
  "modules/hr/lifecycle/termination.service.ts",
  "modules/hr/time/leaves-approval.service.ts",
  "modules/hr/time/leaves-write.service.ts",
  "modules/organization/hierarchy/org-unit-crud.ts",
];

describe("HRMS critical services — logCritical is called and awaited", () => {
  it.each(MUTATION_SERVICES_WITH_CRITICAL_AUDIT)(
    "awaits logCritical in %s",
    (relativePath) => {
      const report = scanServiceAuditAwaits(join(BACKEND_ROOT, "src", relativePath));
      expect(totalAuditWrites(report)).toBeGreaterThan(0);
      expect(awaitedAuditWrites(report)).toBe(totalAuditWrites(report));
    },
  );
});

const COMPLIANCE_SERVICES_WITH_AUDIT = [
  "modules/hr/governance/legal-holds/legal-holds.service.ts",
  "modules/hr/governance/retention/retention.service.ts",
];

describe("compliance services — audit calls present", () => {
  it.each(COMPLIANCE_SERVICES_WITH_AUDIT)(
    "audit calls exist in %s",
    (relativePath) => {
      const source = src(`src/${relativePath}`);
      const hasAudit =
        source.includes("this.audit.log(") ||
        source.includes("this.audit.logCritical(");
      expect(hasAudit).toBe(true);
    },
  );
});

describe("agent token audit attribution", () => {
  const tokenServiceSrc = src("src/modules/agent-access/agent-tokens.service.ts");

  it("token issuance is audited", () => {
    expect(tokenServiceSrc).toMatch(/agent_token\.issued/);
    expect(tokenServiceSrc).toMatch(/this\.audit\.log\s*\(/);
  });

  it("token revocation is audited", () => {
    expect(tokenServiceSrc).toMatch(/agent_token\.revoked/);
  });

  it("audit metadata includes tokenPrefix not a full token value", () => {
    expect(tokenServiceSrc).toMatch(/tokenPrefix/);
    const auditLogCall = tokenServiceSrc.slice(
      tokenServiceSrc.indexOf("agent_token.issued"),
      tokenServiceSrc.indexOf("return {"),
    );
    expect(auditLogCall).not.toMatch(/raw\s*:/);
  });
});

describe("isPlatformEvent CHECK constraint", () => {
  const schemaSrc = src("src/db/schema/common/audit-logs.ts");

  it("CHECK constraint enforces (orgId IS NULL) = isPlatformEvent", () => {
    expect(schemaSrc).toMatch(/chk_audit_logs_tenant_or_platform/);
    expect(schemaSrc).toMatch(/IS NULL.*isPlatformEvent|isPlatformEvent.*IS NULL/s);
  });
});
