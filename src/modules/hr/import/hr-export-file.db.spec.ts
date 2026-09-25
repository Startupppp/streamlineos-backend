/**
 * V-013. `hr-export-local-fallback.spec.ts` asserts `rowCount === 3` against a
 * MOCKED `files.generateLocal` that was told to return 3. It proves the job
 * service copies a number, and nothing about the file.
 *
 * What was never asserted is the part that can actually be wrong: that the CSV
 * `HrExportFileService` writes holds a header and one line per employee of THIS
 * tenant, and no line from another. The query is a five-way join with a keyset
 * cursor and a scope predicate — exactly the shape a double cannot stand in for.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --forceExit \
 *     --testPathPattern=hr-export-file
 */
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { ScopedRead } from "../../access/scoped-read";
import { EMPLOYEE_EXPORT_CSV_HEADER } from "./hr-export-csv";
import { HrExportFileService } from "./hr-export-file.service";

const describeDb = dbSpecSuite();

describeDb("employee export file — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "hr-export-file.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let service: HrExportFileService;

  const orgId = `qa-export-file-${randomUUID()}`;
  const otherOrgId = `qa-export-other-${randomUUID()}`;
  const ownerOf = (org: string) => `qa-owner-${org}`;
  // Three people in the tenant under test: the owner plus two hires.
  const MINE = ["ada", "grace"];
  const NEIGHBOUR = "mallory";
  const userIdOf = (org: string, handle: string) => `qa-user-${handle}-${org}`;
  const emailOf = (org: string, handle: string) => `${handle}.${org}@example.test`;

  const seedOrg = async (org: string, handles: string[]) => {
    const owner = ownerOf(org);
    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${owner}, ${emailOf(org, "owner")}, ${"QA Owner"})`;
      const [seq] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const membershipId = Number(seq?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${org}, ${`QA Export Co ${org.slice(-6)}`}, ${org}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${org}, ${owner}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)
      `;
      for (const handle of handles) {
        const userId = userIdOf(org, handle);
        await tx`
          insert into users (id, email, name, first_name, last_name, is_active)
          values (${userId}, ${emailOf(org, handle)}, ${handle}, ${handle}, ${"QaTester"}, true)
        `;
        await tx`
          insert into organization_members (org_id, user_id, role, status, is_owner)
          values (${org}, ${userId}, ${"MEMBER"}, ${"ACTIVE"}, false)
        `;
      }
    });
  };

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    const db = drizzle(sql, { schema });
    // Object storage is never reached: `generateLocal` writes the temp file and
    // stops, which is precisely the path whose row count was being asserted
    // against a mock.
    service = new HrExportFileService(db, {} as never);

    await seedOrg(orgId, MINE);
    await seedOrg(otherOrgId, [NEIGHBOUR]);
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id in (${orgId}, ${otherOrgId})`;
    await sql`delete from users where email like ${"%@example.test"} and id like ${"qa-%"} and (id like ${`%${orgId}`} or id like ${`%${otherOrgId}`})`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  const exportOf = async (org: string) => {
    const local = await service.generateLocal(
      {
        exportJobId: randomUUID(),
        read: ScopedRead.of(org, ownerOf(org), "all"),
        filters: {},
        createdAt: new Date("2026-09-25T00:00:00Z"),
      } as never,
      async () => undefined,
    );
    const csv = readFileSync(local.tempPath, "utf8");
    unlinkSync(local.tempPath);
    return { local, csv };
  };

  it("writes a header and one row per tenant employee, and none from another tenant", async () => {
    const { local, csv } = await exportOf(orgId);

    const lines = csv.trim().split(/\r?\n/);
    // Owner + two hires. The mocked suite could only ever repeat the number it
    // was handed; this one counts lines in a file.
    expect(local.rowCount).toBe(MINE.length + 1);
    expect(lines).toHaveLength(MINE.length + 2);
    for (const column of EMPLOYEE_EXPORT_CSV_HEADER) expect(lines[0]).toContain(column);
    for (const handle of MINE) expect(csv).toContain(emailOf(orgId, handle));

    // The neighbouring tenant's employee must not appear by name or by email.
    expect(csv).not.toContain(emailOf(otherOrgId, NEIGHBOUR));
    expect(csv).not.toContain(NEIGHBOUR);
    expect(local.fileSizeBytes).toBeGreaterThan(0);
  });

  it("gives the neighbouring tenant its own two rows", async () => {
    // Positive control (BE-141): the exclusion above is the tenant predicate,
    // not an export that produced nothing for anybody.
    const { local, csv } = await exportOf(otherOrgId);
    expect(local.rowCount).toBe(2);
    expect(csv).toContain(emailOf(otherOrgId, NEIGHBOUR));
    for (const handle of MINE) expect(csv).not.toContain(emailOf(orgId, handle));
  });
});
