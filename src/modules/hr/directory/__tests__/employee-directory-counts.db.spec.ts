/**
 * `/hr/employees` renders a summary next to its filtered list. The summary used to
 * come from the org-wide command-center headcount (`hr_employments.lifecycle_status`),
 * while the list filters `users.is_active` under the caller's DataScope, so with the
 * Active filter applied the page could show three cards under a summary that said
 * "Active 1". `GET /hr/employees/counts` now runs the list's own predicate builder,
 * and this suite pins that the two agree on a real catalog for every filter the
 * page can send. A mocked database would answer whatever it was handed and prove
 * nothing about which rows the two queries actually select.
 *
 *   ALLOW_DESTRUCTIVE_DB_TESTS=1 HR_PROBE_DATABASE_URL=postgres://…/streamline_test \
 *     npx jest --config ./jest-db.json --runInBand --forceExit employee-directory-counts.db
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { CacheService } from "../../../../common/cache/cache.service";
import { ScopedRead } from "../../../access/scoped-read";
import { EmploymentFactsService } from "../../../directory/employment-facts.service";
import { EmployeesService, type EmployeeDirectoryFilters } from "../employees.service";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "employee-directory-counts.db.spec.ts",
    vars: ["HR_PROBE_DATABASE_URL", "DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return postgres(url.toString(), {
    prepare: false,
    max: 1,
    ssl: local ? false : "require",
    connect_timeout: 30,
    onnotice: () => {},
  });
}

interface SeededEmployee {
  userId: string;
  departmentId: string;
  designation: string;
  isActive: boolean;
}

const ORG_SCOPED_TABLES = ["hr_employments", "hr_people", "org_units"] as const;

describe("GET /hr/employees/counts agrees with GET /hr/employees on a real catalog", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let service: EmployeesService;
  let probe: ProbeOrg;
  let foreign: ProbeOrg;
  let engineering: string;
  let sales: string;
  let seeded: SeededEmployee[];

  async function seedEmployee(
    org: ProbeOrg,
    tag: string,
    departmentId: string,
    designation: string,
    isActive: boolean,
  ): Promise<SeededEmployee> {
    const userId = `${org.userId}-${tag}`;
    await sql`
      INSERT INTO users (id, email, name, is_active)
      VALUES (${userId}, ${`${userId}@synthetic.invalid`}, ${`Probe ${tag}`}, ${isActive})`;
    await sql`
      INSERT INTO organization_members (user_id, org_id, role, is_owner, status, joined_at)
      VALUES (${userId}, ${org.orgId}, 'MEMBER', false, 'ACTIVE', now())`;
    const [person] = await sql<{ id: number }[]>`
      INSERT INTO hr_people (org_id, user_id) VALUES (${org.orgId}, ${userId}) RETURNING id`;
    await sql`
      INSERT INTO hr_employments
        (org_id, person_id, employee_number, lifecycle_status, designation, department_id, is_primary)
      VALUES
        (${org.orgId}, ${person.id}, ${`EMP-${tag}`}, ${isActive ? "ACTIVE" : "EXITED"},
         ${designation}, ${departmentId}, true)`;
    return { userId, departmentId, designation, isActive };
  }

  async function seedDepartment(org: ProbeOrg, name: string): Promise<string> {
    const id = `${org.orgId}-dept-${name.toLowerCase()}`;
    await sql`
      INSERT INTO org_units (id, org_id, kind, name, code, status)
      VALUES (${id}, ${org.orgId}, 'DEPARTMENT', ${name}, ${name.toUpperCase()}, 'ACTIVE')`;
    return id;
  }

  async function listAll(read: ScopedRead, filters: EmployeeDirectoryFilters, isActive: "true" | "false" | "all") {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listEmployees(read, { ...filters, isActive, cursor, limit: 2 });
      ids.push(...page.data.map((row) => row.id));
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  }

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    service = new EmployeesService(db, new CacheService(null), new EmploymentFactsService(db));
    probe = await createProbeOrg(sql, "hr-directory-counts");
    foreign = await createProbeOrg(sql, "hr-directory-counts-foreign");
    await sql`SELECT set_config('app.organization_id', ${probe.orgId}, false)`;
    engineering = await seedDepartment(probe, "Engineering");
    sales = await seedDepartment(probe, "Sales");
    seeded = [
      await seedEmployee(probe, "eng-active", engineering, "Engineer", true),
      await seedEmployee(probe, "sales-active", sales, "Seller", true),
      await seedEmployee(probe, "eng-exited", engineering, "Engineer", false),
      await seedEmployee(probe, "sales-exited", sales, "Seller", false),
    ];
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    for (const org of [probe, foreign]) {
      if (!org) continue;
      const memberIds = seeded
        .filter((employee) => employee.userId.startsWith(org.userId))
        .map((employee) => employee.userId);
      await sql`DELETE FROM organization_members WHERE org_id = ${org.orgId} AND user_id = ANY(${memberIds})`;
      await dropProbeOrg(sql, org, ORG_SCOPED_TABLES);
      await sql`DELETE FROM users WHERE id = ANY(${memberIds})`;
    }
    await sql.end({ timeout: 5 });
  }, 60_000);

  it("Active filter: the active count equals the filtered list length, exited employees fall into inactive", async () => {
    const read = ScopedRead.of(probe.orgId, probe.userId, "all");
    const counts = await service.countEmployees(read, {});
    const active = await listAll(read, {}, "true");
    const inactive = await listAll(read, {}, "false");

    expect(counts).toEqual({ active: 3, inactive: 2 });
    expect(active).toHaveLength(counts.active);
    expect(inactive).toHaveLength(counts.inactive);
  });

  it("All statuses: active + inactive equals the unfiltered list length", async () => {
    const read = ScopedRead.of(probe.orgId, probe.userId, "all");
    const counts = await service.countEmployees(read, {});
    const all = await listAll(read, {}, "all");

    expect(all).toHaveLength(counts.active + counts.inactive);
  });

  it("search + Active: the count is narrowed by the same search predicate as the list", async () => {
    const read = ScopedRead.of(probe.orgId, probe.userId, "all");
    const counts = await service.countEmployees(read, { search: "Engineer" });
    const active = await listAll(read, { search: "Engineer" }, "true");

    expect(counts).toEqual({ active: 1, inactive: 1 });
    expect(active).toEqual([seeded[0]?.userId]);
  });

  it("department filter: the count follows the list's employment join", async () => {
    const read = ScopedRead.of(probe.orgId, probe.userId, "all");
    const counts = await service.countEmployees(read, { departmentId: sales });
    const active = await listAll(read, { departmentId: sales }, "true");

    expect(counts).toEqual({ active: 1, inactive: 1 });
    expect(active).toEqual([seeded[1]?.userId]);
  });

  it("empty Active set: a search nobody matches counts zero and lists nothing", async () => {
    const read = ScopedRead.of(probe.orgId, probe.userId, "all");
    const counts = await service.countEmployees(read, { search: "no-such-employee" });
    const active = await listAll(read, { search: "no-such-employee" }, "true");

    expect(counts).toEqual({ active: 0, inactive: 0 });
    expect(active).toEqual([]);
  });

  it("own scope: the count is narrowed to the caller exactly like the list", async () => {
    const self = seeded[0];
    if (!self) throw new Error("fixture missing");
    const read = ScopedRead.of(probe.orgId, self.userId, "own");
    const counts = await service.countEmployees(read, {});
    const active = await listAll(read, {}, "true");

    expect(counts).toEqual({ active: 1, inactive: 0 });
    expect(active).toEqual([self.userId]);
  });

  it("denied scope: neither the count nor the list reaches the database", async () => {
    const read = ScopedRead.of(probe.orgId, probe.userId, "none");

    await expect(service.countEmployees(read, {})).resolves.toEqual({ active: 0, inactive: 0 });
    await expect(listAll(read, {}, "all")).resolves.toEqual([]);
  });

  it("cross-org probe: another organisation filtering by this org's department counts zero", async () => {
    await sql`SELECT set_config('app.organization_id', ${foreign.orgId}, false)`;
    try {
      const read = ScopedRead.of(foreign.orgId, foreign.userId, "all");
      const counts = await service.countEmployees(read, { departmentId: engineering });
      const active = await listAll(read, { departmentId: engineering }, "all");

      expect(counts).toEqual({ active: 0, inactive: 0 });
      expect(active).toEqual([]);
    } finally {
      await sql`SELECT set_config('app.organization_id', ${probe.orgId}, false)`;
    }
  });
});
