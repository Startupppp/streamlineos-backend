import { join } from "node:path";
import {
  awaitedAuditWrites,
  scanAuditAwaits,
  scanServiceAuditAwaits,
  totalAuditWrites,
  type HelperResolver,
} from "./audit-await-scan";

const BACKEND_ROOT = join(__dirname, "..", "..");

const HELPER_AWAITS = `
import type { AuditService } from "../../../common/audit/audit.service";

export interface OrgUnitAuditEvent { action: string; userId: string; orgId: string; targetId: string; }

export async function recordOrgUnitAudit(audit: AuditService, event: OrgUnitAuditEvent): Promise<void> {
  await audit.logCritical({ ...event, targetType: "org_unit" });
}
`;

const HELPER_FIRES_AND_FORGETS = HELPER_AWAITS.replace(
  "await audit.logCritical(",
  "void audit.logCritical(",
);

const HELPER_BEST_EFFORT = HELPER_AWAITS.replace(
  "await audit.logCritical(",
  "audit.log({ action: event.action });\n  await audit.logCritical(",
);

const resolverFor =
  (helper: string): HelperResolver =>
  (specifier) =>
    specifier === "./org-unit-crud" ? helper : undefined;

const DELEGATING_SERVICE = `
import { recordOrgUnitAudit } from "./org-unit-crud";

export class OrgHierarchyBranchesService {
  async createOrgBranch(orgId: string, userId: string) {
    const row = await this.insert();
    await recordOrgUnitAudit(this.audit, { action: "org.branch.created", userId, orgId, targetId: row.id });
    return row;
  }
}
`;

describe("audit-await scan — it still fails when the write is not awaited", () => {
  it("counts a direct awaited write", () => {
    const source = `class S { async f() { await this.audit.logCritical({ action: "a" }); } }`;
    const report = scanAuditAwaits(source, () => undefined);
    expect([totalAuditWrites(report), awaitedAuditWrites(report)]).toEqual([1, 1]);
  });

  it("BITE — a direct write left unawaited is reported unawaited", () => {
    const source = `class S { async f() { this.audit.logCritical({ action: "a" }); } }`;
    const report = scanAuditAwaits(source, () => undefined);
    expect([totalAuditWrites(report), awaitedAuditWrites(report)]).toEqual([1, 0]);
  });

  it("follows one hop into an imported helper that awaits the write", () => {
    const report = scanAuditAwaits(DELEGATING_SERVICE, resolverFor(HELPER_AWAITS));
    expect(report.helpers).toEqual(["recordOrgUnitAudit"]);
    expect([totalAuditWrites(report), awaitedAuditWrites(report)]).toEqual([1, 1]);
  });

  it("BITE — a delegated write the caller does not await is reported unawaited", () => {
    const report = scanAuditAwaits(
      DELEGATING_SERVICE.replace("await recordOrgUnitAudit(", "void recordOrgUnitAudit("),
      resolverFor(HELPER_AWAITS),
    );
    expect([totalAuditWrites(report), awaitedAuditWrites(report)]).toEqual([1, 0]);
  });

  it("counts a tail return as awaited — the failure still reaches the caller", () => {
    const returned = scanAuditAwaits(
      DELEGATING_SERVICE.replace("await recordOrgUnitAudit(", "return recordOrgUnitAudit("),
      resolverFor(HELPER_AWAITS),
    );
    expect([totalAuditWrites(returned), awaitedAuditWrites(returned)]).toEqual([1, 1]);
  });

  it("BITE — a bare call statement is neither awaited nor returned", () => {
    const dropped = scanAuditAwaits(
      DELEGATING_SERVICE.replace("await recordOrgUnitAudit(", "recordOrgUnitAudit("),
      resolverFor(HELPER_AWAITS),
    );
    expect([totalAuditWrites(dropped), awaitedAuditWrites(dropped)]).toEqual([1, 0]);
  });

  it("BITE — the hop is not a rubber stamp: a helper that does not await taints every call site", () => {
    const report = scanAuditAwaits(DELEGATING_SERVICE, resolverFor(HELPER_FIRES_AND_FORGETS));
    expect([totalAuditWrites(report), awaitedAuditWrites(report)]).toEqual([1, 0]);
  });

  it("BITE — a service with no audit write at all counts zero, so the >0 assertion bites", () => {
    const source = `class S { async f() { await this.db.insert(rows).values({}); } }`;
    const report = scanAuditAwaits(source, resolverFor(HELPER_AWAITS));
    expect(totalAuditWrites(report)).toBe(0);
  });

  it("sees the best-effort audit.log through the hop as well as in the service", () => {
    expect(scanAuditAwaits(DELEGATING_SERVICE, resolverFor(HELPER_AWAITS)).bestEffortLog).toBe(false);
    expect(scanAuditAwaits(DELEGATING_SERVICE, resolverFor(HELPER_BEST_EFFORT)).bestEffortLog).toBe(true);
    const inline = `class S { async f() { this.audit.log({ action: "a" }); } }`;
    expect(scanAuditAwaits(inline, () => undefined).bestEffortLog).toBe(true);
  });

  it("ignores an import that resolves to a module writing no audit entry", () => {
    const source = `import { getOrgUnitRowFilter } from "./org-unit-crud";
export class S { f() { return getOrgUnitRowFilter("o", "BRANCH", "i"); } }`;
    const report = scanAuditAwaits(source, resolverFor(HELPER_AWAITS));
    expect([report.helpers, totalAuditWrites(report)]).toEqual([[], 0]);
  });

  it("ANTI-VACUITY — the hop is what carries real production audit writes", () => {
    const workLogs = scanServiceAuditAwaits(
      join(BACKEND_ROOT, "src/modules/hr/time/work-logs.service.ts"),
    );
    expect(workLogs.direct).toBe(2);
    expect(workLogs.delegated).toBe(1);
    expect(workLogs.delegatedAwaited).toBe(1);

    const attendance = scanServiceAuditAwaits(
      join(BACKEND_ROOT, "src/modules/hr/time/attendance.service.ts"),
    );
    expect(attendance.direct).toBe(0);
    expect(attendance.delegated).toBe(1);
    expect(attendance.delegatedAwaited).toBe(1);
  });
});
