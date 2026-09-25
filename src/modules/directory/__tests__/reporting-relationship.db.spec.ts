import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import type { AuditEntry } from "../../../common/audit/audit.service";
import type { DataScope } from "../../access/access.types";
import { orgBusinessDate } from "../../hr/time/attendance-business-date";
import { ReportingLineService } from "../reporting-line.service";
import { ScopedRead } from "../../access/scoped-read";
import { ReportingManagerPolicyService } from "../reporting-manager-policy.service";
import { ReportingManagerFallbackResolver } from "../reporting-manager-fallback.resolver";
import { ReportingRelationshipService } from "../reporting-relationship.service";
import type { SetRelationshipsCommand } from "../reporting-line.types";
import { connectProbe, ReportingProbe, type ProbePerson } from "./reporting-probe";

jest.setTimeout(120_000);

class RecordingAudit {
  readonly entries: AuditEntry[] = [];

  async logCritical(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class GrantedAccess {
  readonly grants = new Map<string, Map<string, DataScope>>();

  async holds(): Promise<boolean> {
    return false;
  }

  async resolveUserPermissions(_orgId: string, userId: string): Promise<Map<string, DataScope>> {
    return this.grants.get(userId) ?? new Map();
  }
}

class RecordingInvalidation {
  readonly hierarchy: string[] = [];
  readonly namespaces: string[] = [];

  async invalidateAfterMutation(orgId: string): Promise<void> {
    this.hierarchy.push(orgId);
  }

  async invalidateNamespace(namespace: string): Promise<void> {
    this.namespaces.push(namespace);
  }
}

describe("ReportingRelationshipService against a real schema", () => {
  let sql: ReturnType<typeof connectProbe>;
  let db: Db;
  let probe: ReportingProbe;
  let audit: RecordingAudit;
  let access: GrantedAccess;
  let relationships: ReportingRelationshipService;
  let fallback: ReportingManagerFallbackResolver;
  let invalidation: RecordingInvalidation;
  let today: string;

  const owner = () => ({ orgId: probe.orgId, userId: probe.owner.userId, isOrgOwner: true });
  const member = (person: ProbePerson) => ({ orgId: probe.orgId, userId: person.userId, isOrgOwner: false });

  function set(cmd: Partial<SetRelationshipsCommand> & { subjectUserId: string; primaryManagerUserId: string | null }) {
    const full: SetRelationshipsCommand = { orgId: probe.orgId, actor: owner(), effectiveFrom: today, source: "MANUAL", ...cmd };
    return db.transaction((tx) => relationships.setRelationships(tx, full));
  }

  async function primaryLines(person: ProbePerson) {
    return sql<{ id: number; manager_employment_id: number; effective_from: string; effective_to: string; source: string; change_reason: string | null }[]>`
      SELECT id, manager_employment_id, effective_from::text, effective_to::text, source, change_reason
      FROM hr_reporting_lines WHERE org_id = ${probe.orgId} AND employment_id = ${person.employmentId} AND line_type = 'primary'
      ORDER BY effective_from, id`;
  }

  beforeAll(async () => {
    sql = connectProbe("reporting-relationship.db.spec.ts");
    db = drizzle(sql, { schema });
    probe = await ReportingProbe.create(sql, "rl-relationships");
    audit = new RecordingAudit();
    access = new GrantedAccess();
    const lines = new ReportingLineService(db);
    const policies = new ReportingManagerPolicyService(db, access, lines, audit);
    invalidation = new RecordingInvalidation();
    relationships = new ReportingRelationshipService(db, lines, policies, audit, invalidation as never, invalidation as never);
    fallback = new ReportingManagerFallbackResolver(db, lines, policies);
    today = await orgBusinessDate(db, probe.orgId);
  });

  afterAll(async () => {
    if (probe) await probe.drop();
    if (sql) await sql.end({ timeout: 5 });
  });

  it("writes a primary and two secondary lines with provenance, and one audit row, emitting no outbox event", async () => {
    await probe.policy({ max: 2 });
    const employee = await probe.person("full");
    const boss = await probe.person("full-boss");
    const project = await probe.person("full-project");
    const functional = await probe.person("full-functional");
    const auditBefore = audit.entries.length;

    const result = await set({
      subjectUserId: employee.userId,
      primaryManagerUserId: boss.userId,
      secondary: [{ managerUserId: project.userId, label: "Project" }, { managerUserId: functional.userId }],
      reason: "Joined the platform team",
    });

    expect(result.changed).toBe(true);
    expect(result.after.primary?.managerUserId).toBe(boss.userId);
    expect(result.after.secondary.map((entry) => entry.managerUserId).sort()).toEqual([project.userId, functional.userId].sort());
    const [line] = await primaryLines(employee);
    expect(line).toMatchObject({ source: "MANUAL", change_reason: "Joined the platform team", effective_from: today, effective_to: "infinity" });
    expect(audit.entries.slice(auditBefore).map((entry) => entry.action)).toEqual(["hr.reporting_line.changed"]);
    const events = await sql`SELECT event_type FROM outbox_events WHERE organization_id = ${probe.orgId} AND aggregate_id = ${String(employee.employmentId)}`;
    expect(events).toHaveLength(0);
  });

  it("invalidates the org hierarchy and the employee list after a change, and not after a write that changes nothing", async () => {
    await probe.policy({ max: 0 });
    const employee = await probe.person("invalidate");
    const boss = await probe.person("invalidate-boss");
    const before = { hierarchy: invalidation.hierarchy.length, namespaces: invalidation.namespaces.length };

    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId });
    expect(invalidation.hierarchy.slice(before.hierarchy)).toEqual([probe.orgId]);
    expect(invalidation.namespaces.slice(before.namespaces)).toEqual([expect.stringContaining(probe.orgId)]);

    const unchanged = await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId });
    expect(unchanged.changed).toBe(false);
    expect(invalidation.hierarchy.slice(before.hierarchy)).toHaveLength(1);
  });

  it("keeps a scheduled secondary manager's start date when the set names them again, and adds the new one from today", async () => {
    await probe.policy({ max: 2 });
    const employee = await probe.person("keep-scheduled");
    const boss = await probe.person("keep-scheduled-boss");
    const scheduled = await probe.person("keep-scheduled-s");
    const added = await probe.person("keep-scheduled-t");
    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId });
    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: scheduled.userId }], effectiveFrom: "2099-01-01" });
    const secondaryLines = () => sql<{ id: number; manager_employment_id: number; effective_from: string }[]>`
      SELECT id, manager_employment_id, effective_from::text FROM hr_reporting_lines
      WHERE org_id = ${probe.orgId} AND employment_id = ${employee.employmentId} AND line_type <> 'primary' ORDER BY id`;
    const [before] = await secondaryLines();

    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: scheduled.userId }, { managerUserId: added.userId }] });

    const after = await secondaryLines();
    expect(after).toEqual([
      { id: before?.id, manager_employment_id: scheduled.employmentId, effective_from: "2099-01-01" },
      { id: expect.any(Number), manager_employment_id: added.employmentId, effective_from: today },
    ]);
  });

  it("replaces a kept secondary line only when its label changes", async () => {
    await probe.policy({ max: 1 });
    const employee = await probe.person("relabel");
    const boss = await probe.person("relabel-boss");
    const secondary = await probe.person("relabel-s");
    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: secondary.userId, label: "Project" }], effectiveFrom: "2099-01-01" });
    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: secondary.userId, label: "Functional" }] });

    const lines = await sql<{ relationship_label: string | null; effective_from: string }[]>`
      SELECT relationship_label, effective_from::text FROM hr_reporting_lines
      WHERE org_id = ${probe.orgId} AND employment_id = ${employee.employmentId} AND line_type <> 'primary' ORDER BY id`;
    expect(lines).toEqual([{ relationship_label: "Functional", effective_from: today }]);
  });

  it("stamps ONBOARDING_FALLBACK on the fallback primary only; a chosen secondary is recorded as selected and never reads as a fallback", async () => {
    await probe.policy({ max: 1 });
    const hire = await probe.person("fallback-source");
    const fallbackBoss = await probe.person("fallback-source-boss");
    const chosen = await probe.person("fallback-source-chosen");
    await set({ subjectUserId: hire.userId, primaryManagerUserId: fallbackBoss.userId, secondary: [{ managerUserId: chosen.userId }], source: "ONBOARDING_FALLBACK" });

    const sources = await sql<{ line_type: string; source: string }[]>`
      SELECT line_type, source FROM hr_reporting_lines WHERE org_id = ${probe.orgId} AND employment_id = ${hire.employmentId} ORDER BY line_type::text`;
    expect(sources).toEqual([
      { line_type: "matrix", source: "ONBOARDING_SELECTED" },
      { line_type: "primary", source: "ONBOARDING_FALLBACK" },
    ]);
    const line = await new ReportingLineService(db).getLine(ScopedRead.of(probe.orgId, probe.owner.userId, "all"), hire.userId);
    expect(line?.current?.isFallback).toBe(true);
    expect(line?.secondary.map((entry) => entry.isFallback)).toEqual([false]);

    const bulkHire = await probe.person("bulk-source");
    await set({
      subjectUserId: bulkHire.userId,
      primaryManagerUserId: fallbackBoss.userId,
      secondary: [{ managerUserId: chosen.userId }],
      source: "ONBOARDING_FALLBACK",
      secondarySource: "BULK_ONBOARDING",
    });
    const [bulkSecondary] = await sql<{ source: string }[]>`
      SELECT source FROM hr_reporting_lines WHERE org_id = ${probe.orgId} AND employment_id = ${bulkHire.employmentId} AND line_type <> 'primary'`;
    expect(bulkSecondary?.source).toBe("BULK_ONBOARDING");
  });

  it("enforces the policy's secondary cap", async () => {
    await probe.policy({ max: 1 });
    const employee = await probe.person("cap");
    const boss = await probe.person("cap-boss");
    const one = await probe.person("cap-one");
    const two = await probe.person("cap-two");

    await expect(
      set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: one.userId }, { managerUserId: two.userId }] }),
    ).rejects.toMatchObject({ code: "SECONDARY_CAP_EXCEEDED" });
    await expect(set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: one.userId }] })).resolves.toMatchObject({ changed: true });
  });

  it("supersedes a same-day line instead of ending it before it starts, and never deletes it", async () => {
    await probe.policy({ max: 0 });
    const employee = await probe.person("same-day");
    const first = await probe.person("same-day-first");
    const second = await probe.person("same-day-second");

    await set({ subjectUserId: employee.userId, primaryManagerUserId: first.userId });
    const [replaced] = await primaryLines(employee);
    await set({ subjectUserId: employee.userId, primaryManagerUserId: second.userId });

    expect((await primaryLines(employee)).map((row) => [row.manager_employment_id, row.effective_from, row.effective_to])).toEqual([
      [second.employmentId, today, "infinity"],
    ]);
    const archived = await sql`SELECT line_id, superseded_reason FROM hr_reporting_lines_superseded WHERE org_id = ${probe.orgId} AND employment_id = ${employee.employmentId}`;
    expect(archived).toEqual([{ line_id: replaced.id, superseded_reason: "REPLACED" }]);
    const inverted = await sql`SELECT 1 FROM hr_reporting_lines WHERE org_id = ${probe.orgId} AND effective_to < effective_from`;
    expect(inverted).toHaveLength(0);
  });

  it("closes the line in force the day before a back-dated change and supersedes a scheduled one", async () => {
    const employee = await probe.person("dated");
    const old = await probe.person("dated-old");
    const scheduled = await probe.person("dated-scheduled");
    const corrected = await probe.person("dated-corrected");
    await probe.line(employee, old, "2026-01-01", "2098-12-31");
    await probe.line(employee, scheduled, "2099-01-01");

    await set({ subjectUserId: employee.userId, primaryManagerUserId: corrected.userId, effectiveFrom: "2026-03-01" });

    expect((await primaryLines(employee)).map((row) => [row.manager_employment_id, row.effective_from, row.effective_to])).toEqual([
      [old.employmentId, "2026-01-01", "2026-02-28"],
      [corrected.employmentId, "2026-03-01", "infinity"],
    ]);
  });

  it("refuses direct, indirect and future-dated cycles, and accepts a manager above in the chain", async () => {
    const ceo = await probe.person("cycle-ceo");
    const head = await probe.person("cycle-head");
    const lead = await probe.person("cycle-lead");
    const later = await probe.person("cycle-later");
    await probe.line(head, ceo, "2026-01-01");
    await probe.line(lead, head, "2026-01-01");
    await probe.line(later, ceo, "2099-01-01");

    await expect(set({ subjectUserId: ceo.userId, primaryManagerUserId: head.userId })).rejects.toMatchObject({ code: "PRIMARY_CYCLE" });
    await expect(set({ subjectUserId: ceo.userId, primaryManagerUserId: lead.userId })).rejects.toMatchObject({ code: "PRIMARY_CYCLE" });
    await expect(set({ subjectUserId: ceo.userId, primaryManagerUserId: later.userId })).rejects.toMatchObject({ code: "PRIMARY_CYCLE" });
    await expect(set({ subjectUserId: lead.userId, primaryManagerUserId: ceo.userId })).resolves.toMatchObject({ changed: true });
  });

  it("counts real changes for the D4 guard: three pass, the fourth needs a reason and elevated authority", async () => {
    await probe.policy({ threshold: 3 });
    const employee = await probe.person("guard");
    const hr = await probe.person("guard-hr");
    const managers = await Promise.all([1, 2, 3, 4].map((index) => probe.person(`guard-boss-${index}`)));

    for (const boss of managers.slice(0, 3))
      await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, actor: member(hr) });
    const fourth = { subjectUserId: employee.userId, primaryManagerUserId: managers[3].userId };

    await expect(set({ ...fourth, actor: member(hr) })).rejects.toMatchObject({ code: "CHANGE_REASON_REQUIRED" });
    await expect(set({ ...fourth, actor: member(hr), reason: "Team merged into platform" })).rejects.toMatchObject({ code: "ELEVATED_AUTHORITY_REQUIRED" });
    access.grants.set(hr.userId, new Map([["hr:reporting-lines:override", "all"]]));
    const allowed = await set({ ...fourth, actor: member(hr), reason: "Team merged into platform" });
    expect(allowed.warnings).toContain("PRIMARY_CHANGE_THRESHOLD_EXCEEDED");
  });

  it("writes a high-severity audit for an emergency change", async () => {
    const employee = await probe.person("emergency");
    const boss = await probe.person("emergency-boss");
    const auditBefore = audit.entries.length;

    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, emergency: true, reason: "Manager left without notice" });

    const written = audit.entries.slice(auditBefore);
    expect(written.map((entry) => entry.action)).toEqual(["hr.reporting_line.changed", "hr.reporting_line.emergency_override"]);
    expect(written[1].metadata).toMatchObject({ severity: "high", source: "EMERGENCY_OVERRIDE" });
    expect((await primaryLines(employee))[0].source).toBe("EMERGENCY_OVERRIDE");
  });

  it("keeps a top-level role exclusive of a primary manager", async () => {
    const founder = await probe.person("founder");
    const boss = await probe.person("founder-boss");
    await set({ subjectUserId: founder.userId, primaryManagerUserId: boss.userId });

    const topLevel = await set({ subjectUserId: founder.userId, primaryManagerUserId: null, topLevelReason: "Founder and CEO", effectiveFrom: "2099-06-01" });
    expect(topLevel.after).toMatchObject({ primary: null, topLevel: { reason: "Founder and CEO", effectiveFrom: "2099-06-01" } });
    await expect(
      set({ subjectUserId: founder.userId, primaryManagerUserId: boss.userId, topLevelReason: "Founder" }),
    ).rejects.toMatchObject({ code: "TOP_LEVEL_WITH_MANAGER" });

    await set({ subjectUserId: founder.userId, primaryManagerUserId: boss.userId, effectiveFrom: "2099-06-01" });
    const roles = await sql`SELECT effective_from::text, effective_to::text, ended_at IS NOT NULL AS ended FROM hr_top_level_roles WHERE org_id = ${probe.orgId} AND employment_id = ${founder.employmentId}`;
    expect(roles).toEqual([{ effective_from: "2099-06-01", effective_to: "2099-06-01", ended: true }]);
  });

  it("previews a batch without writing anything", async () => {
    const employee = await probe.person("preview");
    const boss = await probe.person("preview-boss");
    const before = await primaryLines(employee);

    const results = await relationships.validateMany(probe.orgId, [
      { orgId: probe.orgId, actor: owner(), subjectUserId: employee.userId, primaryManagerUserId: boss.userId, effectiveFrom: today, source: "BULK_REASSIGNMENT" },
      { orgId: probe.orgId, actor: owner(), subjectUserId: employee.userId, primaryManagerUserId: employee.userId, effectiveFrom: today, source: "BULK_REASSIGNMENT" },
      { orgId: probe.orgId, actor: owner(), subjectUserId: "nobody", primaryManagerUserId: boss.userId, effectiveFrom: today, source: "BULK_REASSIGNMENT" },
    ]);

    expect(results.map((result) => result.issues.map((issue) => issue.code))).toEqual([[], ["SELF_REFERENCE"], ["EMPLOYEE_NOT_FOUND"]]);
    expect(await primaryLines(employee)).toEqual(before);
  });

  it("reads secondary lines, the change count and a top-level role, hiding reasons from readers without manage or review", async () => {
    await probe.policy({ max: 2 });
    const employee = await probe.person("read-model");
    const boss = await probe.person("read-model-boss");
    const project = await probe.person("read-model-project");
    const founder = await probe.person("read-model-founder");
    await set({ subjectUserId: employee.userId, primaryManagerUserId: boss.userId, secondary: [{ managerUserId: project.userId, label: "Project" }], reason: "Initial assignment" });
    await set({ subjectUserId: founder.userId, primaryManagerUserId: null, topLevelReason: "Founder and CEO" });
    const lines = new ReportingLineService(db);
    const read = ScopedRead.of(probe.orgId, probe.owner.userId, "all");

    const hr = await lines.getLine(read, employee.userId, { permittedActions: { manage: true, review: false, override: false } });
    expect(hr?.current).toMatchObject({ managerUserId: boss.userId, relationshipType: "PRIMARY", source: "MANUAL", changeReason: "Initial assignment" });
    expect(hr?.secondary).toEqual([expect.objectContaining({ relationshipType: "SECONDARY", label: "Project", manager: expect.objectContaining({ userId: project.userId }) })]);
    expect(hr).toMatchObject({ primaryChangesLast24h: 1, maxSecondaryManagers: 2, topLevel: null, pendingRequest: null });

    const plain = await lines.getLine(read, employee.userId);
    expect(plain?.current?.changeReason).toBeNull();
    expect(await lines.getLine(read, founder.userId, { permittedActions: { manage: false, review: true, override: false } })).toMatchObject({
      current: null,
      topLevel: { reason: "Founder and CEO", effectiveFrom: today },
    });
    expect((await lines.getLine(read, founder.userId))?.topLevel).toEqual({ reason: null, effectiveFrom: today });
  });

  it("reports top-level employees apart from missing managers, and lists unconfirmed fallbacks until HR confirms them", async () => {
    await probe.policy({ max: 0 });
    const ceo = await probe.person("coverage-ceo");
    const orphan = await probe.person("coverage-orphan");
    const hire = await probe.person("coverage-hire");
    await set({ subjectUserId: ceo.userId, primaryManagerUserId: null, topLevelReason: "Chief executive" });
    await set({ subjectUserId: hire.userId, primaryManagerUserId: ceo.userId, source: "ONBOARDING_FALLBACK" });
    const lines = new ReportingLineService(db);

    const report = await lines.coverage(probe.orgId);
    expect(report.withoutManager.map((row) => row.userId)).toContain(orphan.userId);
    expect(report.withoutManager.map((row) => row.userId)).not.toContain(ceo.userId);
    expect(report.summary.topLevel).toBeGreaterThanOrEqual(1);
    expect(report.fallback).toEqual(expect.arrayContaining([expect.objectContaining({ userId: hire.userId, managerUserId: ceo.userId })]));
    expect(report.policyMissing).toBe(true);

    await expect(db.transaction((tx) => relationships.confirmFallback(tx, { orgId: probe.orgId, actor: owner(), subjectUserId: hire.userId }))).resolves.toMatchObject({ confirmed: true });
    expect((await lines.coverage(probe.orgId)).fallback.map((row) => row.userId)).not.toContain(hire.userId);
  });

  it("narrows the fallback list and its count to the one employee an own-scoped reader may see", async () => {
    await probe.policy({ max: 0 });
    const lead = await probe.person("scoped-coverage-lead");
    const mine = await probe.person("scoped-coverage-mine");
    const theirs = await probe.person("scoped-coverage-theirs");
    await set({ subjectUserId: mine.userId, primaryManagerUserId: lead.userId, source: "ONBOARDING_FALLBACK" });
    await set({ subjectUserId: theirs.userId, primaryManagerUserId: lead.userId, source: "ONBOARDING_FALLBACK" });
    const lines = new ReportingLineService(db);

    const everyone = await lines.coverage(probe.orgId);
    expect(everyone.fallback.map((row) => row.userId)).toEqual(expect.arrayContaining([mine.userId, theirs.userId]));

    const own = await lines.coverage(probe.orgId, { onlyUserId: mine.userId });
    expect(own.fallback.map((row) => row.userId)).toEqual([mine.userId]);
    expect(own.summary.fallback).toBe(1);
    expect(own.pendingReview.every((row) => row.userId === mine.userId)).toBe(true);
  });

  it("resolves the policy to its defaults until a row exists, then reports the default manager's live eligibility", async () => {
    const empty = await ReportingProbe.create(sql, "rl-policy-defaults");
    try {
      const policies = new ReportingManagerPolicyService(db, access, new ReportingLineService(db), audit);
      await expect(policies.get(empty.orgId)).resolves.toMatchObject({
        isConfigured: false,
        maxSecondaryManagersPerEmployee: 0,
        defaultPrimaryManagerUserId: null,
        fallbackOrder: "CONFIGURED_MANAGER_THEN_UPLOADER",
        requireReasonAfterChanges: 3,
        allowTopLevelWithoutManager: true,
        version: 0,
        defaultPrimaryManager: null,
      });

      const boss = await empty.person("policy-default");
      await empty.policy({ max: 2, defaultManager: boss.userId, order: "UPLOADER_THEN_CONFIGURED_MANAGER", threshold: 5 });
      await expect(policies.get(empty.orgId)).resolves.toMatchObject({
        isConfigured: true,
        maxSecondaryManagersPerEmployee: 2,
        fallbackOrder: "UPLOADER_THEN_CONFIGURED_MANAGER",
        requireReasonAfterChanges: 5,
        version: 1,
        defaultPrimaryManager: { userId: boss.userId, name: "policy-default", eligible: true },
      });

      await sql`UPDATE hr_employments SET lifecycle_status = 'EXITED' WHERE id = ${boss.employmentId}`;
      await expect(policies.get(empty.orgId)).resolves.toMatchObject({ defaultPrimaryManager: { userId: boss.userId, eligible: false } });
    } finally {
      await empty.drop();
    }
  });

  describe("fallback resolution (PRD D2)", () => {
    it("prefers the configured default, then the acting administrator, then refuses", async () => {
      const defaultBoss = await probe.person("default-boss");
      await probe.policy({ defaultManager: defaultBoss.userId, order: "CONFIGURED_MANAGER_THEN_UPLOADER" });
      const hr = await probe.person("plain-hr");

      const [configured] = await fallback.resolveMany(probe.orgId, owner(), [{ key: 1, employeeEmail: "new@synthetic.invalid" }]);
      expect(configured).toMatchObject({ ok: true, managerUserId: defaultBoss.userId, resolution: "FALLBACK_CONFIGURED" });

      await sql`UPDATE hr_employments SET lifecycle_status = 'EXITED' WHERE id = ${defaultBoss.employmentId}`;
      const [uploader] = await fallback.resolveMany(probe.orgId, owner(), [{ key: 2, employeeEmail: "new@synthetic.invalid" }]);
      expect(uploader).toMatchObject({ ok: true, managerUserId: probe.owner.userId, resolution: "FALLBACK_UPLOADER" });

      const [none] = await fallback.resolveMany(probe.orgId, member(hr), [{ key: 3, employeeEmail: "new@synthetic.invalid" }]);
      expect(none).toMatchObject({ ok: false, code: "NO_DEFAULT_REPORTING_MANAGER" });
    });

    it("tries the administrator first when the policy says so, and skips a non-administrator", async () => {
      const defaultBoss = await probe.person("default-boss-2");
      await probe.policy({ defaultManager: defaultBoss.userId, order: "UPLOADER_THEN_CONFIGURED_MANAGER" });
      const hr = await probe.person("plain-hr-2");

      const [admin] = await fallback.resolveMany(probe.orgId, owner(), [{ key: 1 }]);
      expect(admin).toMatchObject({ ok: true, managerUserId: probe.owner.userId, resolution: "FALLBACK_UPLOADER" });
      const [plain] = await fallback.resolveMany(probe.orgId, member(hr), [{ key: 2 }]);
      expect(plain).toMatchObject({ ok: true, managerUserId: defaultBoss.userId, resolution: "FALLBACK_CONFIGURED" });
    });

    it("never replaces an invalid supplied manager with a fallback, and resolves managers named in the same file", async () => {
      const exited = await probe.person("exited-boss", { lifecycle: "EXITED" });
      const named = await probe.person("named-boss");

      const results = await fallback.resolveMany(probe.orgId, owner(), [
        { key: 1, primaryManagerUserId: exited.userId },
        { key: 2, primaryManagerEmail: named.email.toUpperCase() },
        { key: 3, employeeEmail: "lead@synthetic.invalid" },
        { key: 4, employeeEmail: "report@synthetic.invalid", primaryManagerEmail: "lead@synthetic.invalid" },
        { key: 5, primaryManagerEmail: "stranger@synthetic.invalid" },
      ]);

      expect(results[0]).toMatchObject({ ok: false, code: "MANAGER_NOT_ELIGIBLE" });
      expect(results[1]).toMatchObject({ ok: true, managerUserId: named.userId, resolution: "IN_FILE" });
      expect(results[3]).toMatchObject({ ok: true, managerUserId: null, resolution: "IN_FILE", dependsOnRow: 3 });
      expect(results[4]).toMatchObject({ ok: false, code: "MANAGER_NOT_FOUND" });
    });
  });
});
