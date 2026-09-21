import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../test/helpers/probe-org";
import { ReportingLineService } from "../reporting-line.service";
import { ScopedRead } from "../../access/scoped-read";
import { SPAN_OF_CONTROL_LIMIT } from "../reporting-line.types";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "reporting-line.db.spec.ts",
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

describe("ReportingLineService against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let service: ReportingLineService;
  const extraUserIds: string[] = [];
  let counter = 0;

  async function addPerson(
    label: string,
    options: { lifecycle?: string; userActive?: boolean; membershipStatus?: string } = {},
  ): Promise<Person> {
    counter += 1;
    const userId = `${org.userId}-${label}-${counter}`;
    extraUserIds.push(userId);
    await sql`
      INSERT INTO users (id, email, name, is_active)
      VALUES (${userId}, ${`${userId}@synthetic.invalid`}, ${label}, ${options.userActive ?? true})`;
    const [member] = await sql<{ id: number }[]>`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${org.orgId}, 'MEMBER', false, ${options.membershipStatus ?? "ACTIVE"}, now())
      RETURNING id`;
    const [person] = await sql<{ id: number }[]>`
      INSERT INTO hr_people (org_id, user_id) VALUES (${org.orgId}, ${userId}) RETURNING id`;
    const [employment] = await sql<{ id: number }[]>`
      INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date)
      VALUES (${org.orgId}, ${person.id}, ${`EMP-${label}-${counter}`}, ${options.lifecycle ?? "ACTIVE"}, true, '2026-01-01')
      RETURNING id`;
    return { userId, membershipId: member.id, employmentId: employment.id };
  }

  async function line(subject: Person, manager: Person, effectiveFrom = "2026-01-01"): Promise<void> {
    await sql`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from)
      VALUES (${org.orgId}, ${subject.employmentId}, ${manager.employmentId}, 'primary', ${effectiveFrom})`;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "reporting-line");
    service = new ReportingLineService(db);
  });

  afterAll(async () => {
    if (org)
      await dropProbeOrg(sql, org, ["hr_reporting_lines", "hr_employments", "hr_people"]);
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  it("refuses a manager who is not a member, is inactive, has no employment, or has exited", async () => {
    const subject = await addPerson("subject");
    const inactive = await addPerson("inactive", { userActive: false });
    const suspendedMember = await addPerson("suspended-member", { membershipStatus: "SUSPENDED" });
    const exited = await addPerson("exited", { lifecycle: "EXITED" });
    const noEmployment = `${org.userId}-no-employment`;
    extraUserIds.push(noEmployment);
    await sql`INSERT INTO users (id, email, name, is_active) VALUES (${noEmployment}, ${`${noEmployment}@synthetic.invalid`}, 'No employment', true)`;
    await sql`INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at) VALUES (${noEmployment}, ${org.orgId}, 'MEMBER', false, 'ACTIVE', now())`;

    await expect(service.checkManagerAssignment(org.orgId, subject.userId, subject.userId)).resolves.toMatchObject({ ok: false, reason: "self-reference" });
    await expect(service.checkManagerAssignment(org.orgId, subject.userId, "nobody")).resolves.toMatchObject({ ok: false, reason: "manager-not-in-organization" });
    await expect(service.checkManagerAssignment(org.orgId, subject.userId, suspendedMember.userId)).resolves.toMatchObject({ ok: false, reason: "manager-not-in-organization" });
    await expect(service.checkManagerAssignment(org.orgId, subject.userId, inactive.userId)).resolves.toMatchObject({ ok: false, reason: "manager-inactive" });
    await expect(service.checkManagerAssignment(org.orgId, subject.userId, noEmployment)).resolves.toMatchObject({ ok: false, reason: "manager-has-no-employment" });
    await expect(service.checkManagerAssignment(org.orgId, subject.userId, exited.userId)).resolves.toMatchObject({ ok: false, reason: "manager-exited" });
  });

  it("refuses a manager whose chain already passes through the subject, and accepts one who is above", async () => {
    const ceo = await addPerson("ceo");
    const head = await addPerson("head");
    const lead = await addPerson("lead");
    await line(head, ceo);
    await line(lead, head);

    await expect(service.checkManagerAssignment(org.orgId, ceo.userId, lead.userId)).resolves.toMatchObject({ ok: false, reason: "circular" });
    await expect(service.checkManagerAssignment(org.orgId, ceo.userId, head.userId)).resolves.toMatchObject({ ok: false, reason: "circular" });
    await expect(service.checkManagerAssignment(org.orgId, lead.userId, ceo.userId)).resolves.toMatchObject({ ok: true, managerEmploymentId: ceo.employmentId });
  });

  it("assign writes an effective-dated line and getLine reports current, upcoming and history", async () => {
    const boss = await addPerson("boss");
    const newBoss = await addPerson("new-boss");
    const report = await addPerson("report");

    await service.assign(org.orgId, report.userId, boss.userId, "2026-02-01", org.userId);
    await service.assign(org.orgId, report.userId, newBoss.userId, "2099-01-01", org.userId);

    const view = await service.getLine(ScopedRead.of(org.orgId, org.userId, "all"), report.userId);
    expect(view?.current?.managerUserId).toBe(boss.userId);
    expect(view?.current?.effectiveTo).toBe("2098-12-31");
    expect(view?.upcoming.map((entry) => entry.managerUserId)).toEqual([newBoss.userId]);
    expect(view?.history).toHaveLength(2);
  });

  it("getLine answers null when the caller's scope cannot see the employee", async () => {
    const hidden = await addPerson("hidden");
    const view = await service.getLine(ScopedRead.of(org.orgId, org.userId, "own"), hidden.userId);
    expect(view).toBeNull();
  });

  it("coverage lists employees without a manager, inactive managers, cycles, and spans over the limit", async () => {
    const orphan = await addPerson("orphan");
    const exitedManager = await addPerson("exited-manager", { lifecycle: "EXITED" });
    const stranded = await addPerson("stranded");
    await line(stranded, exitedManager);
    const cycleA = await addPerson("cycle-a");
    const cycleB = await addPerson("cycle-b");
    await line(cycleA, cycleB);
    await line(cycleB, cycleA);
    const wide = await addPerson("wide");
    for (let index = 0; index <= SPAN_OF_CONTROL_LIMIT; index += 1) {
      const direct = await addPerson(`direct-${index}`);
      await line(direct, wide);
    }

    const report = await service.coverage(org.orgId);

    expect(report.withoutManager.map((row) => row.userId)).toContain(orphan.userId);
    expect(report.inactiveManager).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: stranded.userId, managerUserId: exitedManager.userId, managerState: "exited" })]),
    );
    expect(report.circular.map((cycle) => [...cycle.userIds].sort())).toEqual(
      expect.arrayContaining([[cycleA.userId, cycleB.userId].sort()]),
    );
    expect(report.overSpan).toEqual(
      expect.arrayContaining([expect.objectContaining({ managerUserId: wide.userId, directReports: SPAN_OF_CONTROL_LIMIT + 1 })]),
    );
    expect(report.summary.employees).toBe(report.summary.withManager + report.summary.withoutManager);
    expect(report.summary.circular).toBe(report.circular.length);
  });
});
