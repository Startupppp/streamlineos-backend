import { connectProbe, ReportingProbe } from "./reporting-probe";

jest.setTimeout(120_000);

async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
    throw error;
  }
}

describe("hr_reporting_lines constraints (migrations 1214-1219)", () => {
  let sql: ReturnType<typeof connectProbe>;
  let a: ReportingProbe;
  let b: ReportingProbe;

  beforeAll(async () => {
    sql = connectProbe("reporting-line-constraints.db.spec.ts");
    a = await ReportingProbe.create(sql, "rl-constraints-a");
    b = await ReportingProbe.create(sql, "rl-constraints-b");
  });

  afterAll(async () => {
    if (a) await a.drop();
    if (b) await b.drop();
    if (sql) await sql.end({ timeout: 5 });
  });

  it("allows one open primary line per employee and refuses a second, while a closed line beside it is fine", async () => {
    const employee = await a.person("open-primary");
    const first = await a.person("first-boss");
    const second = await a.person("second-boss");
    await a.line(employee, first, "2026-01-01", "2026-05-31");
    await a.line(employee, second, "2026-06-01");

    expect(await sqlState(() => a.line(employee, first, "2027-01-01"))).toMatch(/^(23505|23P01)$/);
    const [index] = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_hr_reporting_lines_open_primary'`;
    expect(index.indexdef).toContain("(org_id, employment_id)");
    expect(index.indexdef).toContain("line_type = 'primary'");
    expect(index.indexdef).toContain("effective_to = 'infinity'::date");
  });

  it("refuses primary lines that share even one inclusive day, and accepts adjacent ones", async () => {
    const employee = await a.person("overlap");
    const first = await a.person("overlap-boss-1");
    const second = await a.person("overlap-boss-2");
    await a.line(employee, first, "2026-01-01", "2026-06-30");

    expect(await sqlState(() => a.line(employee, second, "2026-06-30"))).toBe("23P01");
    expect(await sqlState(() => a.line(employee, second, "2026-07-01"))).toBeNull();
  });

  it("allows two concurrent secondary lines to different managers", async () => {
    const employee = await a.person("two-secondaries");
    const primary = await a.person("two-secondaries-primary");
    const project = await a.person("project-lead");
    const functional = await a.person("functional-lead");
    await a.line(employee, primary, "2026-01-01");

    expect(await sqlState(() => a.line(employee, project, "2026-01-01", "infinity", "matrix"))).toBeNull();
    expect(await sqlState(() => a.line(employee, functional, "2026-01-01", "infinity", "dotted"))).toBeNull();
  });

  it("refuses the same secondary manager twice over the same days, whatever the secondary type", async () => {
    const employee = await a.person("same-secondary");
    const lead = await a.person("same-secondary-lead");
    await a.line(employee, lead, "2026-01-01", "infinity", "matrix");

    expect(await sqlState(() => a.line(employee, lead, "2026-03-01", "infinity", "dotted"))).toBe("23P01");
    expect(await sqlState(() => a.line(employee, lead, "2026-03-01", "infinity", "matrix"))).toBe("23P01");
  });

  it("refuses a line that ends before it starts or names the employee as their own manager", async () => {
    const employee = await a.person("bad-dates");
    const boss = await a.person("bad-dates-boss");

    expect(await sqlState(() => a.line(employee, boss, "2026-05-02", "2026-05-01"))).toMatch(/^(23514|22000)$/);
    expect(await sqlState(() => a.line(employee, employee, "2026-01-01"))).toBe("23514");
    expect(await sqlState(() => a.line(employee, boss, "2026-05-01", "2026-05-01"))).toBeNull();
  });

  it("refuses a relationship label on a primary line", async () => {
    const employee = await a.person("label");
    const boss = await a.person("label-boss");
    const state = await sqlState(() => sql`
      INSERT INTO hr_reporting_lines (org_id, employment_id, manager_employment_id, line_type, effective_from, relationship_label)
      VALUES (${a.orgId}, ${employee.employmentId}, ${boss.employmentId}, 'primary', '2026-01-01', 'Project')`);
    expect(state).toBe("23514");
  });

  it("keeps every new HRM-15 table tenant-isolated for the app role", async () => {
    const employeeB = await b.person("isolated-b");
    const bossB = await b.person("isolated-b-boss");
    await b.line(employeeB, bossB, "2026-01-01");
    await b.policy({ max: 2 });
    await sql`INSERT INTO hr_top_level_roles (org_id, employment_id, reason, effective_from) VALUES (${b.orgId}, ${bossB.employmentId}, 'Founder', '2026-01-01')`;
    await sql`
      INSERT INTO hr_reporting_manager_requests (org_id, employee_employment_id, requested_by_user_id, employee_reason)
      VALUES (${b.orgId}, ${employeeB.employmentId}, ${employeeB.userId}, 'My manager on record is not the person I report to.')`;
    const [job] = await sql<{ id: string }[]>`
      INSERT INTO hr_reporting_line_bulk_jobs (org_id, job_reason, created_by) VALUES (${b.orgId}, 'Quarterly reorganisation', ${b.org.userId}) RETURNING id`;
    await sql`
      INSERT INTO hr_reporting_line_bulk_job_rows (org_id, job_id, row_number, employee_email, status)
      VALUES (${b.orgId}, ${job.id}, 1, ${employeeB.email}, 'READY')`;
    await sql`
      INSERT INTO hr_reporting_lines_superseded (org_id, line_id, employment_id, manager_employment_id, line_type, effective_from, effective_to, source, created_at, superseded_reason)
      VALUES (${b.orgId}, -1, ${employeeB.employmentId}, ${bossB.employmentId}, 'primary', '2026-01-01', '2026-01-01', 'MANUAL', now(), 'REPLACED')`;

    const tables = [
      "hr_reporting_lines",
      "hr_reporting_manager_policies",
      "hr_top_level_roles",
      "hr_reporting_manager_requests",
      "hr_reporting_line_bulk_jobs",
      "hr_reporting_line_bulk_job_rows",
      "hr_reporting_lines_superseded",
    ];
    const seenAsA = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE streamline_app`;
      await tx`SELECT set_config('app.organization_id', ${a.orgId}, true)`;
      const counts: Record<string, number> = {};
      for (const table of tables) {
        const [row] = await tx.unsafe<{ foreign: string }[]>(`SELECT count(*) FILTER (WHERE org_id = $1) AS foreign FROM ${table}`, [b.orgId]);
        counts[table] = Number(row.foreign);
      }
      return counts;
    });
    expect(seenAsA).toEqual(Object.fromEntries(tables.map((table) => [table, 0])));

    const seenAsB = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE streamline_app`;
      await tx`SELECT set_config('app.organization_id', ${b.orgId}, true)`;
      const [row] = await tx<{ lines: string }[]>`SELECT count(*) AS lines FROM hr_reporting_lines WHERE org_id = ${b.orgId}`;
      return Number(row.lines);
    });
    expect(seenAsB).toBe(1);

    const crossWrite = await sqlState(() =>
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE streamline_app`;
        await tx`SELECT set_config('app.organization_id', ${a.orgId}, true)`;
        await tx`INSERT INTO hr_reporting_manager_policies (org_id) VALUES (${b.orgId})`;
      }),
    );
    expect(crossWrite).toBe("42501");
  });
});
