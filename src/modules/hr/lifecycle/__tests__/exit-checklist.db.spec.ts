import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { NotFoundException } from "@nestjs/common";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";
import type { DataScope } from "../../../access/access.types";
import type { AccessService } from "../../../access/access.service";
import { EmploymentFactsService } from "../../../directory/employment-facts.service";
import { ReportingLineService } from "../../../directory/reporting-line.service";
import { ApprovalAuthorityService } from "../../../directory/approval-authority.service";
import { HrAuditService } from "../../core/hr-audit.service";
import { ExitChecklistService } from "../exit-checklist.service";
import { EXIT_CHECKLIST_KINDS } from "../dto/exit-checklist.schemas";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "exit-checklist.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 2,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

interface Person {
  userId: string;
  membershipId: number;
  employmentId: number;
}

const membershipIds = new Map<string, number>();

class FakeAccess {
  readonly scopes = new Map<string, Map<string, DataScope>>();

  grant(userId: string, permission: string, scope: DataScope = "all"): void {
    const held = this.scopes.get(userId) ?? new Map<string, DataScope>();
    held.set(permission, scope);
    this.scopes.set(userId, held);
  }

  async resolveUserPermissions(_orgId: string, userId: string): Promise<Map<string, DataScope>> {
    return this.scopes.get(userId) ?? new Map();
  }

  async membersWithPermission(_orgId: string, permission: string): Promise<{ userId: string; membershipId: number }[]> {
    const holders: { userId: string; membershipId: number }[] = [];
    for (const [userId, held] of this.scopes) {
      if (held.get(permission) === "all") holders.push({ userId, membershipId: membershipIds.get(userId) ?? 0 });
    }
    return holders;
  }
}

describe("ExitChecklistService against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let otherOrg: ProbeOrg;
  let access: FakeAccess;
  let service: ExitChecklistService;
  const extraUserIds: string[] = [];
  let counter = 0;

  async function addPerson(label: string): Promise<Person> {
    counter += 1;
    const userId = `${org.userId}-${label}-${counter}`;
    extraUserIds.push(userId);
    await sql`INSERT INTO users (id, email, name, is_active) VALUES (${userId}, ${`${userId}@synthetic.invalid`}, ${label}, true)`;
    const [member] = await sql<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${org.orgId}, 'MEMBER', false, 'ACTIVE', now())
      RETURNING id`;
    membershipIds.set(userId, member.id);
    const [person] = await sql<{ id: number }[]>`INSERT INTO hr_people (org_id, user_id) VALUES (${org.orgId}, ${userId}) RETURNING id`;
    const [employment] = await sql<{ id: number }[]>`
      INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date)
      VALUES (${org.orgId}, ${person.id}, ${`EMP-${label}-${counter}`}, 'ACTIVE', true, '2026-01-01')
      RETURNING id`;
    return { userId, membershipId: member.id, employmentId: employment.id };
  }

  async function line(subject: Person, manager: Person): Promise<void> {
    await sql`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from)
      VALUES (${org.orgId}, ${subject.employmentId}, ${manager.employmentId}, 'primary', '2026-01-01')`;
  }

  async function resign(leaver: Person, lastWorkingDate: string): Promise<number> {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO resignations (org_id, user_id, user_membership_id, reason, status, last_working_date, notice_period_days)
      VALUES (${org.orgId}, ${leaver.userId}, ${leaver.membershipId}, 'moving on', 'FINAL_APPROVED', ${lastWorkingDate}, 30)
      RETURNING id`;
    return row.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "exit-checklist");
    otherOrg = await createProbeOrg(sql, "exit-checklist-other");
    access = new FakeAccess();
    const employment = new EmploymentFactsService(db);
    const approvals = new ApprovalAuthorityService(db, access as unknown as AccessService, employment, new ReportingLineService(db));
    service = new ExitChecklistService(db, approvals, access as unknown as AccessService, new HrAuditService(db));
  });

  afterAll(async () => {
    if (org) {
      await sql`DELETE FROM hr_audit_logs WHERE org_id = ${org.orgId}`;
      await dropProbeOrg(sql, org, ["exit_checklists", "resignations", "hr_reporting_lines", "hr_employments", "hr_people"]);
    }
    if (otherOrg) await dropProbeOrg(sql, otherOrg);
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  it("seeds one typed checklist whose handover goes to the reporting manager who can see exits, idempotently", async () => {
    const manager = await addPerson("manager");
    const leaver = await addPerson("leaver");
    await line(leaver, manager);
    access.grant(manager.userId, "hr:exit:view", "own");
    access.grant(org.userId, "hr:exit:manage");
    const resignationId = await resign(leaver, "2026-10-31");

    await expect(service.seedForResignation(org.orgId, resignationId)).resolves.toEqual({ created: EXIT_CHECKLIST_KINDS.length });
    await expect(service.seedForResignation(org.orgId, resignationId)).resolves.toEqual({ created: 0 });

    const checklist = await service.listForResignation(org.orgId, resignationId, { userId: org.userId, membershipId: org.membershipId, isAdmin: true });
    const handover = checklist.items.find((item) => item.kind === "manager_handover");
    expect(handover?.owner).toMatchObject({ type: "member", membershipId: manager.membershipId, userId: manager.userId });
    expect(handover?.dueDate).toBe("2026-10-24");
    expect(checklist.items.find((item) => item.kind === "final_settlement")?.owner).toEqual({ type: "queue", permission: "hr:payroll:approve", label: "Final settlement queue" });
    expect(checklist.summary).toEqual({ total: EXIT_CHECKLIST_KINDS.length, open: EXIT_CHECKLIST_KINDS.length, done: 0, waived: 0, overdue: 0 });
    await expect(service.resignationIdsRoutedTo(org.orgId, manager.membershipId)).resolves.toEqual([resignationId]);
  });

  it("falls through the chain when the manager cannot see exits: manager's manager, then the HR exits queue", async () => {
    const director = await addPerson("director");
    const manager = await addPerson("blind-manager");
    const leaver = await addPerson("leaver-two");
    await line(manager, director);
    await line(leaver, manager);
    access.grant(director.userId, "hr:exit:view", "own");
    const resignationId = await resign(leaver, "2026-11-15");

    await service.seedForResignation(org.orgId, resignationId);
    const checklist = await service.listForResignation(org.orgId, resignationId, { userId: org.userId, membershipId: org.membershipId, isAdmin: true });

    expect(checklist.items.find((item) => item.kind === "manager_handover")?.owner).toMatchObject({ type: "member", membershipId: director.membershipId });

    const orphan = await addPerson("orphan");
    const orphanResignation = await resign(orphan, "2026-11-30");
    await service.seedForResignation(org.orgId, orphanResignation);
    const orphanChecklist = await service.listForResignation(org.orgId, orphanResignation, { userId: org.userId, membershipId: org.membershipId, isAdmin: true });

    expect(orphanChecklist.items.find((item) => item.kind === "manager_handover")?.owner).toEqual({ type: "queue", permission: "hr:exit:manage", label: "HR exits queue" });
  });

  it("lets the manager close their handover with evidence, records who did it, and refuses the leaver's colleague", async () => {
    const manager = await addPerson("closing-manager");
    const leaver = await addPerson("leaver-three");
    const colleague = await addPerson("colleague");
    await line(leaver, manager);
    access.grant(manager.userId, "hr:exit:view", "own");
    const resignationId = await resign(leaver, "2026-12-31");
    await service.seedForResignation(org.orgId, resignationId);

    const closed = await service.updateItem(
      org.orgId,
      { userId: manager.userId, membershipId: manager.membershipId, isAdmin: false },
      resignationId,
      "manager_handover",
      { status: "DONE", evidence: "Handover pack shared with the team lead" },
    );
    expect(closed).toMatchObject({ status: "DONE", evidence: "Handover pack shared with the team lead", completedBy: { membershipId: manager.membershipId } });
    expect(closed.completedAt).toBeInstanceOf(Date);

    const [audit] = await sql<{ action: string; actor_membership_id: number }[]>`
      SELECT action, actor_membership_id FROM hr_audit_logs WHERE org_id = ${org.orgId} AND entity_id = ${String(closed.id)}`;
    expect(audit).toEqual({ action: "exit_checklist_item_updated", actor_membership_id: manager.membershipId });

    const colleagueActor = { userId: colleague.userId, membershipId: colleague.membershipId, isAdmin: false };
    await expect(
      service.updateItem(org.orgId, colleagueActor, resignationId, "asset_return", { status: "DONE", evidence: "x" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.openItemCount(org.orgId, resignationId)).resolves.toBe(EXIT_CHECKLIST_KINDS.length - 1);

    const reassigned = await service.updateItem(
      org.orgId,
      { userId: org.userId, membershipId: org.membershipId, isAdmin: true },
      resignationId,
      "asset_return",
      { ownerUserId: colleague.userId, dueDate: "2027-01-05" },
    );
    expect(reassigned).toMatchObject({ owner: { type: "member", membershipId: colleague.membershipId, userId: colleague.userId }, dueDate: "2027-01-05" });
    await expect(
      service.updateItem(org.orgId, colleagueActor, resignationId, "asset_return", { status: "DONE", evidence: "Laptop and badge collected" }),
    ).resolves.toMatchObject({ status: "DONE" });
    await expect(
      service.updateItem(org.orgId, { userId: org.userId, membershipId: org.membershipId, isAdmin: true }, resignationId, "asset_return", { ownerUserId: "nobody-here" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("answers 404 for another organisation's resignation", async () => {
    const leaver = await addPerson("leaver-four");
    const resignationId = await resign(leaver, "2026-12-31");
    await service.seedForResignation(org.orgId, resignationId);

    await expect(
      service.updateItem(otherOrg.orgId, { userId: otherOrg.userId, membershipId: otherOrg.membershipId, isAdmin: true }, resignationId, "asset_return", { notes: "n" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listForResignation(otherOrg.orgId, resignationId, { userId: otherOrg.userId, membershipId: otherOrg.membershipId, isAdmin: true })).resolves.toMatchObject({ items: [] });
  });
});
