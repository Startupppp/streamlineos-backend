import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../test/helpers/probe-org";
import type { DataScope } from "../../access/access.types";
import type { AccessService } from "../../access/access.service";
import { EmploymentFactsService } from "../employment-facts.service";
import { ReportingLineService } from "../reporting-line.service";
import { ApprovalAuthorityService } from "../approval-authority.service";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "approval-authority.db.spec.ts",
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
      const scope = held.get(permission);
      if (scope === "all") holders.push({ userId, membershipId: membershipIds.get(userId) ?? 0 });
    }
    return holders;
  }
}

const membershipIds = new Map<string, number>();

describe("ApprovalAuthorityService against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let access: FakeAccess;
  let service: ApprovalAuthorityService;
  const extraUserIds: string[] = [];
  const orgUnitIds: string[] = [];
  const insertedPermissionKeys: string[] = [];
  let counter = 0;

  async function addPerson(label: string, options: { lifecycle?: string; departmentId?: string | null } = {}): Promise<Person> {
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
      INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date, department_id)
      VALUES (${org.orgId}, ${person.id}, ${`EMP-${label}-${counter}`}, ${options.lifecycle ?? "ACTIVE"}, true, '2026-01-01', ${options.departmentId ?? null})
      RETURNING id`;
    return { userId, membershipId: member.id, employmentId: employment.id };
  }

  async function line(subject: Person, manager: Person): Promise<void> {
    await sql`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from)
      VALUES (${org.orgId}, ${subject.employmentId}, ${manager.employmentId}, 'primary', '2026-01-01')`;
  }

  async function department(headMembershipId: number | null): Promise<string> {
    counter += 1;
    const id = `${org.orgId}-dept-${counter}`;
    orgUnitIds.push(id);
    await sql`
      INSERT INTO org_units (id, org_id, kind, name, code, head_membership_id)
      VALUES (${id}, ${org.orgId}, 'DEPARTMENT', ${`Dept ${counter}`}, ${`D${counter}`}, ${headMembershipId})`;
    return id;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "approval-authority");
    access = new FakeAccess();
    const employment = new EmploymentFactsService(db);
    const reportingLines = new ReportingLineService(db);
    service = new ApprovalAuthorityService(db, access as unknown as AccessService, employment, reportingLines);
  });

  afterAll(async () => {
    if (org) {
      await sql`DELETE FROM hr_workflow_delegations WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM user_delegation_permissions WHERE org_id = ${org.orgId}`;
      await sql`DELETE FROM user_delegations WHERE org_id = ${org.orgId}`;
      for (const key of insertedPermissionKeys) await sql`DELETE FROM permissions WHERE name = ${key}`;
      await sql`UPDATE hr_employments SET department_id = NULL WHERE org_id = ${org.orgId}`;
      for (const id of orgUnitIds) await sql`DELETE FROM org_units WHERE id = ${id}`;
      await dropProbeOrg(sql, org, ["hr_reporting_lines", "hr_employments", "hr_people"]);
    }
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  it("routes to the reporting manager who can approve, with the manager's manager as the escalation", async () => {
    const director = await addPerson("director");
    const manager = await addPerson("manager");
    const employee = await addPerson("employee");
    await line(manager, director);
    await line(employee, manager);
    access.grant(manager.userId, "hr:leaves:approve", "own");
    access.grant(director.userId, "hr:leaves:approve", "own");

    const route = await service.resolve(org.orgId, employee.userId, "leave");

    expect(route.rung).toBe("reporting_manager");
    expect(route.approver?.userId).toBe(manager.userId);
    expect(route.assignedTo?.userId).toBe(manager.userId);
    expect(route.delegation).toBeNull();
    expect(route.escalation).toMatchObject({ rung: "managers_manager", approver: expect.objectContaining({ userId: director.userId }) });
    expect(route.skipped).toEqual([{ rung: "department_head", userId: null, reason: "no-department-head" }, { rung: "queue", userId: null, reason: "queue-empty" }]);
    expect(route.slaHours).toBe(48);
    expect(route.explanation).toBe("manager approves as reporting manager.");
  });

  it("skips an exited manager and explains why the manager's manager took the request", async () => {
    const director = await addPerson("director");
    const exited = await addPerson("exited-manager", { lifecycle: "EXITED" });
    const employee = await addPerson("employee");
    await line(exited, director);
    await line(employee, exited);
    access.grant(director.userId, "hr:leaves:approve", "own");

    const route = await service.resolve(org.orgId, employee.userId, "leave");

    expect(route.rung).toBe("managers_manager");
    expect(route.approver?.userId).toBe(director.userId);
    expect(route.skipped[0]).toEqual({ rung: "reporting_manager", userId: exited.userId, reason: "manager-exited" });
    expect(route.explanation).toContain("because reporting manager: the manager has exited");
  });

  it("falls through a manager who lacks the permission to the department head", async () => {
    const head = await addPerson("head");
    const departmentId = await department(head.membershipId);
    const manager = await addPerson("manager");
    const employee = await addPerson("employee", { departmentId });
    await line(employee, manager);
    access.grant(head.userId, "hr:expenses:approve", "all");

    const route = await service.resolve(org.orgId, employee.userId, "expense");

    expect(route.rung).toBe("department_head");
    expect(route.approver?.userId).toBe(head.userId);
    expect(route.skipped).toEqual(
      expect.arrayContaining([
        { rung: "reporting_manager", userId: manager.userId, reason: "lacks-permission" },
        { rung: "managers_manager", userId: null, reason: "no-manager" },
      ]),
    );
    expect(route.escalation).toMatchObject({ rung: "queue", queue: expect.objectContaining({ memberCount: 1 }) });
  });

  it("lands on the permission-holder queue when nobody in the chain can act, never on the employee themselves", async () => {
    const hr = await addPerson("hr");
    const employee = await addPerson("employee");
    access.grant(hr.userId, "timesheets:approvals:manage", "all");
    access.grant(employee.userId, "timesheets:approvals:manage", "all");

    const route = await service.resolve(org.orgId, employee.userId, "timesheet");

    expect(route.rung).toBe("queue");
    expect(route.approver).toBeNull();
    expect(route.queue).toMatchObject({ permission: "timesheets:approvals:manage", label: "Timesheet approvals queue", memberCount: 1 });
    expect(route.queue?.members.map((member) => member.userId)).toEqual([hr.userId]);
    expect(route.explanation).toMatch(/^Routed to the Timesheet approvals queue \(1 approver\) because reporting manager: no reporting manager is on record/);
  });

  it("reports an unowned request explicitly when no rung and no queue can answer", async () => {
    const employee = await addPerson("employee");

    const route = await service.resolve(org.orgId, employee.userId, "travel");

    expect(route.rung).toBeNull();
    expect(route.approver).toBeNull();
    expect(route.queue).toBeNull();
    expect(route.escalation).toBeNull();
    expect(route.explanation).toMatch(/^Nobody can approve this travel request/);
    expect(route.explanation).toContain("hr:travel:manage");
  });

  it("hands the request to the manager's active workflow delegate and says so", async () => {
    const manager = await addPerson("manager");
    const delegate = await addPerson("delegate");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, "hr:leaves:approve", "own");
    await sql`
      INSERT INTO hr_workflow_delegations (org_id, delegator_user_id, delegator_membership_id, delegate_user_id, delegate_membership_id, object_type, starts_at, ends_at, reason, active)
      VALUES (${org.orgId}, ${manager.userId}, ${manager.membershipId}, ${delegate.userId}, ${delegate.membershipId}, 'leave_request', now() - interval '1 day', '2099-03-04T12:00:00Z', 'Annual leave', true)`;

    const route = await service.resolve(org.orgId, employee.userId, "leave");

    expect(route.assignedTo?.userId).toBe(manager.userId);
    expect(route.approver?.userId).toBe(delegate.userId);
    expect(route.delegation).toMatchObject({ source: "workflow", fromUserId: manager.userId, toUserId: delegate.userId, reason: "Annual leave" });
    expect(route.explanation).toBe("manager approves as reporting manager; they are away until 4 Mar 2099, so delegate is acting on their behalf.");
  });

  it("honours a permission delegation of the approving key for kinds outside the HR workflow engine", async () => {
    const manager = await addPerson("manager");
    const delegate = await addPerson("delegate");
    const employee = await addPerson("employee");
    await line(employee, manager);
    access.grant(manager.userId, "timesheets:approvals:manage", "own");
    const delegationId = `${org.orgId}-delegation-${counter}`;
    const [catalogRow] = await sql<{ inserted: boolean }[]>`
      INSERT INTO permissions (name, resource, action, description)
      VALUES ('timesheets:approvals:manage', 'timesheets:approvals', 'manage', 'Approve timesheets')
      ON CONFLICT (name) DO NOTHING
      RETURNING true AS inserted`;
    if (catalogRow?.inserted) insertedPermissionKeys.push("timesheets:approvals:manage");
    await sql`
      INSERT INTO user_delegations (id, org_id, delegator_membership_id, delegatee_membership_id, starts_at, ends_at, status)
      VALUES (${delegationId}, ${org.orgId}, ${manager.membershipId}, ${delegate.membershipId}, now() - interval '1 day', now() + interval '7 days', 'ACTIVE')`;
    await sql`
      INSERT INTO user_delegation_permissions (org_id, delegation_id, permission_key)
      VALUES (${org.orgId}, ${delegationId}, 'timesheets:approvals:manage')`;

    const route = await service.resolve(org.orgId, employee.userId, "timesheet");

    expect(route.approver?.userId).toBe(delegate.userId);
    expect(route.delegation).toMatchObject({ source: "permission", delegationId, toUserId: delegate.userId });
  });
});
