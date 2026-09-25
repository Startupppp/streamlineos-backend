/**
 * V-081. The assets export had no assertion against a real table.
 *
 * `exportEntity` selects whole rows and the controller builds the CSV from
 * `exportColumnsOf(entity)`, so the two things that can go wrong are the ones
 * no mock can show: the header not matching the rows, and the `org_id`
 * predicate not holding. Everything else in this path was already covered by
 * suites that fed the service its own answer back.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --forceExit \
 *     --testPathPattern=hr-export-assets
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { toCsv } from "../../inventory/import-export/csv.util";
import { HrImportService } from "./hr-import.service";
import { exportColumnsOf } from "./hr-export-columns";

const describeDb = dbSpecSuite();

describeDb("assets export — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "hr-export-assets.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let service: HrImportService;
  const orgId = `qa-assets-export-${randomUUID()}`;
  const otherOrgId = `qa-assets-other-${randomUUID()}`;
  const MINE = ["QA Laptop A", "QA Laptop B", "QA Monitor"];

  const seedOrg = async (id: string, name: string, ownerId: string) => {
    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${ownerId}, ${`${ownerId}@example.test`}, ${"QA Owner"})`;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(row?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${id}, ${name}, ${id}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${id}, ${ownerId}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)
      `;
    });
  };

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    const db = drizzle(sql, { schema });
    service = new HrImportService(
      db,
      { log: async () => undefined } as never,
      {} as never,
      { invalidateNamespace: async () => undefined } as never,
    );

    await seedOrg(orgId, "QA Assets Export Co", `qa-owner-${orgId}`);
    await seedOrg(otherOrgId, "QA Other Co", `qa-owner-${otherOrgId}`);

    for (const name of MINE) {
      await sql`
        insert into assets (org_id, name, type, status, serial_number)
        values (${orgId}, ${name}, ${"LAPTOP"}, ${"AVAILABLE"}, ${`SN-${randomUUID().slice(0, 8)}`})
      `;
    }
    // The neighbour's estate. Nothing about it may reach this org's export.
    await sql`
      insert into assets (org_id, name, type, status, serial_number)
      values (${otherOrgId}, ${"NEIGHBOUR SECRET LAPTOP"}, ${"LAPTOP"}, ${"ASSIGNED"}, ${"SN-NEIGHBOUR"})
    `;
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from assets where org_id in (${orgId}, ${otherOrgId})`;
    await sql`delete from organizations where id in (${orgId}, ${otherOrgId})`;
    await sql`delete from users where id in (${`qa-owner-${orgId}`}, ${`qa-owner-${otherOrgId}`})`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  it("returns a header plus one row per asset in the org and none from another org", async () => {
    const page = await service.exportEntity(orgId, "assets", { limit: 100 } as never);
    const rows = page.data as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(MINE.length);
    expect(rows.map((row) => row["name"]).sort()).toEqual([...MINE].sort());
    for (const row of rows) expect(row["orgId"]).toBe(orgId);

    // The CSV the controller actually sends: a header line from the table's own
    // columns plus one line per row. An export with the wrong header is a file
    // whose columns do not line up with its values.
    const headers = exportColumnsOf("assets");
    const csv = toCsv(headers, rows);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1 + MINE.length);
    expect(lines[0]).toContain("serialNumber");
    expect(csv).not.toContain("NEIGHBOUR SECRET LAPTOP");
    expect(csv).not.toContain("SN-NEIGHBOUR");
  });

  it("gives the neighbouring org its own single row, not this org's three", async () => {
    // Positive control (BE-141): the isolation above must be the org predicate,
    // not an export that returns nothing.
    const page = await service.exportEntity(otherOrgId, "assets", { limit: 100 } as never);
    const rows = page.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["name"]).toBe("NEIGHBOUR SECRET LAPTOP");
  });
});
