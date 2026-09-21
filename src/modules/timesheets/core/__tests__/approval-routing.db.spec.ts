import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";
import type { DataScope } from "../../../access/access.types";
import type { AccessService } from "../../../access/access.service";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { EmploymentFactsService } from "../../../directory/employment-facts.service";
import { ReportingLineService } from "../../../directory/reporting-line.service";
import { ApprovalAuthorityService } from "../../../directory/approval-authority.service";
import { TimesheetApprovalRoutingService } from "../approval-routing.service";
import { TimesheetApprovalEscalationSweepService } from "../approval-escalation-sweep.service";
import { TimesheetsAuditService } from "../timesheets-audit.service";
import { TS_APPROVALS_MANAGE_PERMISSION } from "../timesheets-core-scope";
import type { TimesheetApprovalRoute } from "../../../../db/schema/timesheets/periods";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "approval-routing.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), { prepare: false, max: 2, ssl: local ? false : "require", connect_timeout: 30, onnotice: () => {} });
}

interface Person {
  userId: string;
  membershipId: number;
  employmentId: number;
}

interface Notice {
  eventKey: string;
  targetUserIds: string[];
  entityId: string;
}

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
    for (const [userId, held] of this.scopes) if (held.get(permission) === "all") holders.push({ userId, membershipId: membershipIds.get(userId) ?? 0 });
    return holders;
  }
}

const membershipIds = new Map<string, number>();

describe("Timesheet approval routing against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let access: FakeAccess;
  let routing: TimesheetApprovalRoutingService;
  let sweep: TimesheetApprovalEscalationSweepService;
  const notices: Notice[] = [];
  const extraUserIds: string[] = [];
  let counter = 0;
  let workspaceId: string;

  async function addPerson(label: string, options: { lifecycle?: string } = {}): Promise<Person> {
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
      VALUES (${org.orgId}, ${person.id}, ${`EMP-${label}-${counter}`}, ${options.lifecycle ?? "ACTIVE"}, true, '2026-01-01')
      RETURNING id`;
    return { userId, membershipId: member.id, employmentId: employment.id };
  }

  async function line(subject: Person, manager: Person): Promise<void> {
    await sql`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from)
      VALUES (${org.orgId}, ${subject.employmentId}, ${manager.employmentId}, 'primary', '2026-01-01')`;
  }

  async function project(name: string, managerMembershipId: number | null): Promise<number> {
    counter += 1;
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO build.projects (org_id, name, key, manager_membership_id, pm_workspace_id)
      VALUES (${org.orgId}, ${name}, ${`P${counter}`}, ${managerMembershipId}, ${workspaceId})
      RETURNING id`;
    return row.id;
  }

  async function submittedPeriod(owner: Person, approver: Person | null, route: TimesheetApprovalRoute, dueAt: Date): Promise<number> {
    counter += 1;
    const start = new Date(Date.UTC(2026, 0, 1 + counter * 7));
    const end = new Date(start.getTime() + 6 * 86_400_000);
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO timesheet_periods (org_id, user_membership_id, period_start, period_end, status, submitted_at, current_approver_membership_id, approval_route, approval_due_at, total_hours)
      VALUES (${org.orgId}, ${owner.membershipId}, ${start.toISOString().slice(0, 10)}, ${end.toISOString().slice(0, 10)}, 'SUBMITTED', now(), ${approver?.membershipId ?? null}, ${JSON.stringify(route)}::jsonb, ${dueAt.toISOString()}::timestamp, '40')
      RETURNING id`;
    return row.id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "ts-routing");
    workspaceId = `${org.orgId}-ws`;
    await sql`INSERT INTO build.pm_workspaces (pm_workspace_id, org_id, name, slug, is_default) VALUES (${workspaceId}, ${org.orgId}, 'Probe', 'probe', true)`;
    await sql`INSERT INTO timesheet_settings (org_id) VALUES (${org.orgId})`;
    access = new FakeAccess();
    const employment = new EmploymentFactsService(db);
    const reportingLines = new ReportingLineService(db);
    const authority = new ApprovalAuthorityService(db, access as unknown as AccessService, employment, reportingLines);
    routing = new TimesheetApprovalRoutingService(db, access as unknown as AccessService, authority, employment, reportingLines);
    const notifications = {
      emit: (input: Notice) => {
        notices.push({ eventKey: input.eventKey, targetUserIds: input.targetUserIds, entityId: input.entityId });
        return Promise.resolve({ notificationIds: [] });
      },
    } as unknown as NotificationDispatchService;
    sweep = new TimesheetApprovalEscalationSweepService(db, routing, new TimesheetsAuditService(db), notifications);
  });

  afterAll(async () => {
    if (org) {
      await sql`DELETE FROM timesheet_audit_events WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM timesheet_periods WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM timesheet_settings WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM build.projects WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM build.pm_workspaces WHERE org_id = ${org.orgId}`;
      await dropProbeOrg(sql, org, ["hr_reporting_lines", "hr_employments", "hr_people"]);
    }
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    notices.length = 0;
  });

  it("routes to the reporting manager by default, ignoring the dominant project's manager", async () => {
    const manager = await addPerson("manager");
    const pm = await addPerson("pm");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    access.grant(pm.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    const projectId = await project("Apollo", pm.membershipId);

    const decision = await routing.resolve({
      orgId: org.orgId,
      subjectUserId: employee.userId,
      entries: [{ projectId }, { projectId }, { projectId: null }],
      settings: { approvalMode: "MANAGER", approverSource: "REPORTING_MANAGER" },
    });

    expect(decision.kind).toBe("routed");
    if (decision.kind !== "routed") return;
    expect(decision.approver?.userId).toBe(manager.userId);
    expect(decision.route).toMatchObject({ source: "reporting_manager", rung: "reporting_manager", projectId });
  });

  it("routes to the dominant project's manager when the organisation chose project routing", async () => {
    const manager = await addPerson("manager");
    const pm = await addPerson("pm");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    access.grant(pm.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    const apollo = await project("Apollo", pm.membershipId);
    const gemini = await project("Gemini", manager.membershipId);

    const decision = await routing.resolve({
      orgId: org.orgId,
      subjectUserId: employee.userId,
      entries: [{ projectId: apollo }, { projectId: apollo }, { projectId: gemini }],
      settings: { approvalMode: "MANAGER", approverSource: "PROJECT_MANAGER" },
    });

    expect(decision.kind).toBe("routed");
    if (decision.kind !== "routed") return;
    expect(decision.approver?.userId).toBe(pm.userId);
    expect(decision.route).toMatchObject({ source: "project_manager", projectId: apollo, escalationRung: "reporting_manager" });
    expect(decision.route.explanation).toContain("manager of Apollo");
  });

  it("falls back from a project manager who cannot approve to the reporting manager, and says why", async () => {
    const manager = await addPerson("manager");
    const pm = await addPerson("pm");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    const projectId = await project("Apollo", pm.membershipId);

    const decision = await routing.resolve({
      orgId: org.orgId,
      subjectUserId: employee.userId,
      entries: [{ projectId }],
      settings: { approvalMode: "MANAGER", approverSource: "PROJECT_MANAGER" },
    });

    expect(decision.kind).toBe("routed");
    if (decision.kind !== "routed") return;
    expect(decision.approver?.userId).toBe(manager.userId);
    expect(decision.route.explanation).toContain("Apollo could not take it because its manager cannot approve timesheets");
  });

  it("refuses to route a period whose owner manages the project themselves and has no reporting line", async () => {
    const employee = await addPerson("employee");
    const projectId = await project("Solo", employee.membershipId);
    access.grant(employee.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");

    const decision = await routing.resolve({
      orgId: org.orgId,
      subjectUserId: employee.userId,
      entries: [{ projectId }],
      settings: { approvalMode: "MANAGER", approverSource: "PROJECT_MANAGER" },
    });

    expect(decision.kind).toBe("unowned");
    if (decision.kind === "unowned") expect(decision.explanation).toContain("you manage that project yourself");
  });

  it("escalates an overdue period to the next rung, records where it came from, and tells the new approver", async () => {
    const director = await addPerson("director");
    const manager = await addPerson("manager");
    const employee = await addPerson("employee");
    await line(manager, director);
    await line(employee, manager);
    access.grant(manager.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    access.grant(director.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    const overdueRoute: TimesheetApprovalRoute = {
      source: "reporting_manager",
      rung: "reporting_manager",
      approverUserId: manager.userId,
      approverMembershipId: manager.membershipId,
      assignedToUserId: manager.userId,
      delegation: null,
      projectId: null,
      explanation: "manager approves as reporting manager.",
      slaHours: 48,
      escalationRung: "managers_manager",
      escalatedFrom: null,
    };
    const periodId = await submittedPeriod(employee, manager, overdueRoute, new Date("2026-09-19T00:00:00.000Z"));
    const now = new Date("2026-09-21T00:00:00.000Z");

    const outcome = await db.transaction((tx) => sweep.escalateOrg(tx, org.orgId, now));

    expect(outcome).toEqual({ periodsOverdue: 1, periodsEscalated: 1, periodsUnowned: 0 });
    const [period] = await sql<{ current_approver_membership_id: number; approval_route: TimesheetApprovalRoute; escalated_at: string; due_after_now: boolean }[]>`
      SELECT current_approver_membership_id, approval_route, approval_escalated_at::text AS escalated_at, approval_due_at > ${now.toISOString()}::timestamp AS due_after_now
      FROM timesheet_periods WHERE id = ${periodId}`;
    expect(period.current_approver_membership_id).toBe(director.membershipId);
    expect(period.approval_route).toMatchObject({
      rung: "managers_manager",
      approverUserId: director.userId,
      escalatedFrom: { approverUserId: manager.userId, rung: "reporting_manager", at: now.toISOString() },
    });
    expect(period.escalated_at).toBe("2026-09-21 00:00:00");
    expect(period.due_after_now).toBe(true);
    expect(notices).toEqual([{ eventKey: "timesheets.period.escalated", targetUserIds: [director.userId], entityId: String(periodId) }]);
    const audits = await sql<{ action: string }[]>`SELECT action FROM timesheet_audit_events WHERE org_id = ${org.orgId} AND entity_id = ${String(periodId)}`;
    expect(audits.map((row) => row.action)).toEqual(["period.approval_escalated"]);
  });

  it("marks an overdue period it cannot re-route so the sweep does not retry it every tick, and leaves its approver alone", async () => {
    const manager = await addPerson("manager");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    const deadEndRoute: TimesheetApprovalRoute = {
      source: "reporting_manager",
      rung: "reporting_manager",
      approverUserId: manager.userId,
      approverMembershipId: manager.membershipId,
      assignedToUserId: manager.userId,
      delegation: null,
      projectId: null,
      explanation: "manager approves as reporting manager.",
      slaHours: 48,
      escalationRung: "managers_manager",
      escalatedFrom: null,
    };
    const periodId = await submittedPeriod(employee, manager, deadEndRoute, new Date("2026-09-19T00:00:00.000Z"));
    const now = new Date("2026-09-21T00:00:00.000Z");

    const first = await db.transaction((tx) => sweep.escalateOrg(tx, org.orgId, now));
    const second = await db.transaction((tx) => sweep.escalateOrg(tx, org.orgId, now));

    expect(first).toEqual({ periodsOverdue: 1, periodsEscalated: 0, periodsUnowned: 1 });
    expect(second).toEqual({ periodsOverdue: 0, periodsEscalated: 0, periodsUnowned: 0 });
    const [period] = await sql<{ current_approver_membership_id: number; approval_escalated_at: Date | null }[]>`
      SELECT current_approver_membership_id, approval_escalated_at FROM timesheet_periods WHERE id = ${periodId}`;
    expect(period.current_approver_membership_id).toBe(manager.membershipId);
    expect(period.approval_escalated_at).not.toBeNull();
    expect(notices).toEqual([]);
    const audits = await sql<{ action: string }[]>`SELECT action FROM timesheet_audit_events WHERE org_id = ${org.orgId} AND entity_id = ${String(periodId)}`;
    expect(audits.map((row) => row.action)).toEqual(["period.approval_escalation_failed"]);
  });

  it("leaves a period whose deadline has not passed untouched", async () => {
    const manager = await addPerson("manager");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, TS_APPROVALS_MANAGE_PERMISSION, "own");
    const route: TimesheetApprovalRoute = {
      source: "reporting_manager",
      rung: "reporting_manager",
      approverUserId: manager.userId,
      approverMembershipId: manager.membershipId,
      assignedToUserId: manager.userId,
      delegation: null,
      projectId: null,
      explanation: "manager approves as reporting manager.",
      slaHours: 48,
      escalationRung: "managers_manager",
      escalatedFrom: null,
    };
    await submittedPeriod(employee, manager, route, new Date("2026-12-01T00:00:00.000Z"));

    const outcome = await db.transaction((tx) => sweep.escalateOrg(tx, org.orgId, new Date("2026-09-21T00:00:00.000Z")));

    expect(outcome).toEqual({ periodsOverdue: 0, periodsEscalated: 0, periodsUnowned: 0 });
  });
});
