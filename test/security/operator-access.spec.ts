/**
 * operator-access.spec.ts
 *
 * Documents the finding that no operator/support-access module exists.
 *
 * The PRD §20 (operator access) requires: time-bound, approved, reasoned,
 * audited operator access to tenant data.  This spec asserts the absence of
 * such a mechanism and records the concrete failure it permits.
 *
 * FINDING: OPERATOR-BLOCKED / PRODUCT-BLOCKED
 *
 *   Current state: No impersonation or support-access module exists in the
 *   codebase.  Platform admins can access tenant data only through the owner
 *   credential or by bypassing RLS as the database owner — neither path is
 *   time-bound, approved, reasoned or audited.
 *
 *   Concrete failure at scale: A platform engineer who needs to diagnose a
 *   production incident currently has no audited path.  They either:
 *     (a) Use the database owner role (BYPASSRLS, no application audit trail), or
 *     (b) Use an org-owner credential (authenticated as the customer's own
 *         account, impersonating rather than auditing).
 *   Both paths are invisible to the tenant and to the compliance log.
 *
 *   Smallest safe change: A minimal operator-access module would:
 *     1. Insert a time-bound "support session" row into a new
 *        `platform_operator_sessions` table (orgId, operatorUserId, approvedBy,
 *        reason, expiresAt, revokedAt).
 *     2. Issue a JWT with a special `principalType: "operator"` claim scoped to
 *        the target orgId and session expiry.
 *     3. Gate every query in that session on the session row (not just the JWT).
 *     4. Write every access to audit_logs with principalType="operator",
 *        operatorSessionId, and the tenant orgId.
 *     5. Revoke on expiry or on explicit operator revocation.
 *
 *   Unblock condition: product decision on (a) whether operator access to tenant
 *   data is permitted at all, and (b) the approval workflow (single approver?
 *   dual control? customer notification?).
 *
 * Suite: run with  node ./node_modules/jest/bin/jest.js test/security/operator-access.spec.ts
 *   Requires WIRING: "roots" in jest config must include "<rootDir>/test".
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BACKEND_ROOT = join(__dirname, "../..");
const MODULES_DIR = join(BACKEND_ROOT, "src", "modules");

function moduleExists(name: string): boolean {
  return existsSync(join(MODULES_DIR, name));
}

describe("operator access — absence confirmed", () => {
  it("no impersonation module exists", () => {
    expect(moduleExists("impersonation")).toBe(false);
    expect(moduleExists("support-access")).toBe(false);
    expect(moduleExists("operator-access")).toBe(false);
  });

  it("no platform_operator_sessions table in schema", () => {
    const schemaDir = join(BACKEND_ROOT, "src", "db", "schema");
    const allSchemaFiles = readdirSync(schemaDir, { recursive: true, withFileTypes: true })
      .filter((e) => !e.isDirectory() && String(e.name).endsWith(".ts"))
      .map((e) => join(String(e.parentPath ?? e.path), e.name));
    const hasOperatorTable = allSchemaFiles.some((f) => {
      const content = readFileSync(f, "utf8");
      return (
        content.includes("platform_operator_sessions") ||
        content.includes("operator_sessions")
      );
    });
    expect(hasOperatorTable).toBe(false);
  });

  it("PRODUCT-BLOCKED — no operator access mechanism: this spec documents the gap", () => {
    expect(true).toBe(true);
  });
});

describe("operator access — gap severity", () => {
  it("audit_logs has no principalType column (operator access would be unauditable today)", () => {
    const auditSchema = readFileSync(
      join(BACKEND_ROOT, "src/db/schema/common/audit-logs.ts"),
      "utf8",
    );
    expect(auditSchema).not.toMatch(/principal_type|principalType/);
  });

  it("ModuleLadder includes platform-admin for billing delegation only, not operator access", () => {
    const moduleRegistry = readFileSync(
      join(BACKEND_ROOT, "src/common/rbac/module-registry.ts"),
      "utf8",
    );
    expect(moduleRegistry).toMatch(/platform-admin/);
    expect(moduleRegistry).toMatch(/billing.*platform-admin|platform-admin.*billing/is);
  });
});
