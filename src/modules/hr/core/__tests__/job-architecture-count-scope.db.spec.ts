/**
 * Regression test for BE#37: Job architecture list endpoints must return accurate totals.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
 *     --testPathPattern="job-architecture-count-scope.db"
 *
 * Before the fix, GET /hr/org/roles and GET /hr/org/levels returned plain arrays
 * without count metadata. The fix adds a `total` field that runs the same filtered
 * count query in parallel with the data fetch.
 *
 * This test seeds job roles and levels (some active, some inactive) and verifies
 * that the `total` field matches the filtered data array length.
 */
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { HrOrgCatalogService } from "../hr-org-catalog.service";
import { OrgHierarchyService } from "../../../organization/hierarchy/org-hierarchy.service";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "job-architecture-count-scope.db.spec.ts",
    vars: ["DATABASE_URL", "APP_DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

describe("Job architecture count scope alignment (BE#37)", () => {
  let sql: ReturnType<typeof connect>;
  let db: Db;
  let probe: ProbeOrg;
  let ORG_ID: string;
  let catalogService: HrOrgCatalogService;
  let roleIds: number[] = [];
  let levelIds: number[] = [];

  beforeAll(async () => {
    sql = connect();
    db = drizzle(sql, { schema });
    probe = await createProbeOrg(sql, "job-arch-count");
    ORG_ID = probe.orgId;

    const hierarchyService = {} as OrgHierarchyService;
    catalogService = new HrOrgCatalogService(db as never, hierarchyService);

    // Create 3 active and 2 inactive job roles
    const activeRoles = await Promise.all([
      catalogService.createJobRole(ORG_ID, { name: "Engineer", code: "ENG" }),
      catalogService.createJobRole(ORG_ID, { name: "Designer", code: "DES" }),
      catalogService.createJobRole(ORG_ID, { name: "Manager", code: "MGR" }),
    ]);
    roleIds.push(...activeRoles.map((r) => r.id));

    const inactiveRoles = await sql<{ id: number }[]>`
      INSERT INTO hr_job_roles (org_id, name, code, is_active)
      VALUES
        (${ORG_ID}, 'Deprecated Role 1', 'DEP1', false),
        (${ORG_ID}, 'Deprecated Role 2', 'DEP2', false)
      RETURNING id
    `;
    roleIds.push(...inactiveRoles.map((r) => r.id));

    // Create 4 active and 1 inactive job level
    const activeLevels = await Promise.all([
      catalogService.createJobLevel(ORG_ID, { name: "Junior", code: "L1" }),
      catalogService.createJobLevel(ORG_ID, { name: "Mid", code: "L2" }),
      catalogService.createJobLevel(ORG_ID, { name: "Senior", code: "L3" }),
      catalogService.createJobLevel(ORG_ID, { name: "Staff", code: "L4" }),
    ]);
    levelIds.push(...activeLevels.map((l) => l.id));

    const inactiveLevels = await sql<{ id: number }[]>`
      INSERT INTO hr_job_levels (org_id, name, code, is_active)
      VALUES (${ORG_ID}, 'Deprecated Level', 'OLD', false)
      RETURNING id
    `;
    levelIds.push(...inactiveLevels.map((l) => l.id));
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      if (roleIds.length > 0) {
        await sql`DELETE FROM hr_job_roles WHERE id = ANY(${roleIds})`;
      }
      if (levelIds.length > 0) {
        await sql`DELETE FROM hr_job_levels WHERE id = ANY(${levelIds})`;
      }
      if (probe) await dropProbeOrg(sql, probe, []);
      await sql.end({ timeout: 5 });
    }
  }, 60_000);

  it("listJobRoles() total matches data array length", async () => {
    const result = await catalogService.listJobRoles(ORG_ID);

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.data)).toBe(true);

    // Total must match the actual data array length
    expect(result.total).toBe(result.data.length);

    // Should return only active roles (3 in this test)
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(3);

    // All returned roles must be active
    for (const role of result.data) {
      expect(role.isActive).toBe(true);
    }
  });

  it("listJobLevels() total matches data array length", async () => {
    const result = await catalogService.listJobLevels(ORG_ID);

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("total");
    expect(Array.isArray(result.data)).toBe(true);

    // Total must match the actual data array length
    expect(result.total).toBe(result.data.length);

    // Should return only active levels (4 in this test)
    expect(result.total).toBe(4);
    expect(result.data).toHaveLength(4);

    // All returned levels must be active
    for (const level of result.data) {
      expect(level.isActive).toBe(true);
    }
  });

  it("job roles count query uses the same filters as the data query", async () => {
    const result = await catalogService.listJobRoles(ORG_ID);

    // Manually query with the same filters the service should use
    const manualCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count
      FROM hr_job_roles
      WHERE org_id = ${ORG_ID} AND is_active = true
    `;

    const expectedTotal = Number(manualCount[0].count);

    // The service's total must match the manual count with same filters
    expect(result.total).toBe(expectedTotal);
  });

  it("job levels count query uses the same filters as the data query", async () => {
    const result = await catalogService.listJobLevels(ORG_ID);

    // Manually query with the same filters the service should use
    const manualCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count
      FROM hr_job_levels
      WHERE org_id = ${ORG_ID} AND is_active = true
    `;

    const expectedTotal = Number(manualCount[0].count);

    // The service's total must match the manual count with same filters
    expect(result.total).toBe(expectedTotal);
  });

  it("inactive roles are excluded from both data and total", async () => {
    const result = await catalogService.listJobRoles(ORG_ID);

    // We created 2 inactive roles, they should not be in data or total
    const inactiveRoleNames = ["Deprecated Role 1", "Deprecated Role 2"];
    for (const name of inactiveRoleNames) {
      expect(result.data.find((r) => r.name === name)).toBeUndefined();
    }

    // Total should be 3 (active only), not 5 (all)
    expect(result.total).toBe(3);
  });

  it("inactive levels are excluded from both data and total", async () => {
    const result = await catalogService.listJobLevels(ORG_ID);

    // We created 1 inactive level, it should not be in data or total
    expect(result.data.find((l) => l.name === "Deprecated Level")).toBeUndefined();

    // Total should be 4 (active only), not 5 (all)
    expect(result.total).toBe(4);
  });
});
