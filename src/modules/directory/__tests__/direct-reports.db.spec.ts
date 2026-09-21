import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../db/schema";
import type { Db } from "../../../db/drizzle.types";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../test/helpers/probe-org";
import { DirectReportsService } from "../direct-reports.service";

jest.setTimeout(120_000);

function connect() {
  const raw = requireApprovedDatabaseUrl({ spec: "direct-reports.db.spec.ts", vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"] });
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

describe("DirectReportsService against a real schema", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let org: ProbeOrg;
  let service: DirectReportsService;
  const extraUserIds: string[] = [];
  let counter = 0;

  async function addPerson(label: string, options: { lifecycle?: string; member?: boolean; probationEndDate?: string | null } = {}): Promise<Person> {
    counter += 1;
    const userId = `${org.userId}-${label}-${counter}`;
    extraUserIds.push(userId);
    await sql`INSERT INTO users (id, email, name, is_active) VALUES (${userId}, ${`${userId}@synthetic.invalid`}, ${label}, true)`;
    let membershipId = 0;
    if (options.member !== false) {
      const [member] = await sql<{ id: number }[]>`
        INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
        VALUES (${userId}, ${org.orgId}, 'MEMBER', false, 'ACTIVE', now())
        RETURNING id`;
      membershipId = member.id;
    }
    const [person] = await sql<{ id: number }[]>`INSERT INTO hr_people (org_id, user_id) VALUES (${org.orgId}, ${userId}) RETURNING id`;
    const [employment] = await sql<{ id: number }[]>`
      INSERT INTO hr_employments (org_id, person_id, employee_number, lifecycle_status, is_primary, joining_date, designation, probation_end_date)
      VALUES (${org.orgId}, ${person.id}, ${`EMP-${label}-${counter}`}, ${options.lifecycle ?? "ACTIVE"}, true, '2026-01-01', ${`${label} role`}, ${options.probationEndDate ?? null})
      RETURNING id`;
    return { userId, membershipId, employmentId: employment.id };
  }

  async function line(subject: Person, manager: Person, effective: { from: string; to?: string } = { from: "2026-01-01" }): Promise<void> {
    await sql`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from, effective_to)
      VALUES (${org.orgId}, ${subject.employmentId}, ${manager.employmentId}, 'primary', ${effective.from}, ${effective.to ?? "infinity"})`;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    org = await createProbeOrg(sql, "direct-reports");
    service = new DirectReportsService(db);
  });

  afterAll(async () => {
    if (org) await dropProbeOrg(sql, org, ["hr_reporting_lines", "hr_employments", "hr_people"]);
    for (const userId of extraUserIds) await sql`DELETE FROM users WHERE id = ${userId}`;
    if (sql) await sql.end({ timeout: 5 });
  });

  it("lists the people whose current primary line points at the manager, with membership, role and probation, leaving out leavers", async () => {
    const manager = await addPerson("manager");
    const asha = await addPerson("asha", { lifecycle: "PROBATION", probationEndDate: "2026-10-01" });
    const ben = await addPerson("ben");
    const formerReport = await addPerson("former");
    const exited = await addPerson("exited", { lifecycle: "EXITED" });
    const noLogin = await addPerson("nologin", { member: false });
    await line(asha, manager);
    await line(ben, manager);
    await line(formerReport, manager, { from: "2025-01-01", to: "2025-12-31" });
    await line(exited, manager);
    await line(noLogin, manager);

    const reports = await service.list(org.orgId, manager.userId);

    expect(reports.map((report) => report.userId).sort()).toEqual([asha.userId, ben.userId, noLogin.userId].sort());
    expect(reports.find((report) => report.userId === exited.userId)).toBeUndefined();
    expect(reports.find((report) => report.userId === asha.userId)).toMatchObject({
      membershipId: asha.membershipId,
      employmentId: asha.employmentId,
      name: "asha",
      designation: "asha role",
      lifecycleStatus: "PROBATION",
      probationEndDate: "2026-10-01",
    });
    expect(reports.find((report) => report.userId === noLogin.userId)?.membershipId).toBeNull();
    expect(reports.find((report) => report.userId === formerReport.userId)).toBeUndefined();
  });

  it("answers an empty roster for someone nobody reports to, and for another organisation's manager", async () => {
    const loner = await addPerson("loner");
    expect(await service.list(org.orgId, loner.userId)).toEqual([]);

    const other = await createProbeOrg(sql, "direct-reports-other");
    try {
      expect(await service.list(other.orgId, loner.userId)).toEqual([]);
    } finally {
      await dropProbeOrg(sql, other, []);
    }
  });
});
