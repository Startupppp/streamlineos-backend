/**
 * HRMS-E2E-021, against a real Postgres. The manager home's "Approved leave in
 * the next two weeks" read `teamAvailability`, which took the first 100
 * approved leaves in the WHOLE org and only then kept the manager's reports.
 * In an org with more than 100 approved leaves in the window, a report's leave
 * could fall past the cut and simply not appear. The list also carried no
 * status, so it could not show that what it listed was approved.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="team-availability-reports"
 */
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { AccessService } from "../../access/access.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { LeaveLedgerService } from "./leave-ledger.service";
import { LeavesService } from "./leaves.service";

const describeDb = dbSpecSuite();

describeDb("teamAvailability for a manager's reports — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "team-availability-reports.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let leaves: LeavesService;
  const orgId = `qa-avail-${randomUUID()}`;
  const ownerId = `qa-avail-owner-${randomUUID()}`;
  const reportId = `qa-avail-report-${randomUUID()}`;
  const otherIds = Array.from({ length: 101 }, (_, i) => `qa-avail-other-${i}-${randomUUID()}`);

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    const db = drizzle(sql, { schema });
    // Only the database is read by teamAvailability; the other collaborators are inert.
    const module = await Test.createTestingModule({
      providers: [
        LeavesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: {} },
        { provide: AccessService, useValue: {} },
        { provide: LeaveLedgerService, useValue: {} },
        { provide: EmploymentFactsService, useValue: {} },
      ],
    }).compile();
    leaves = module.get(LeavesService);

    await sql.begin(async (tx) => {
      const everyone = [ownerId, reportId, ...otherIds];
      for (const id of everyone) await tx`insert into users (id, email, name) values (${id}, ${`${id}@example.com`}, ${id})`;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      const ownerMembership = Number(row?.id);
      await tx`insert into organizations (id, name, slug, owner_membership_id) values (${orgId}, ${"QA Avail Co"}, ${orgId}, ${ownerMembership})`;
      await tx`insert into organization_members (id, org_id, user_id, role, status, is_owner) values (${ownerMembership}, ${orgId}, ${ownerId}, ${"OWNER"}, ${"ACTIVE"}, true)`;
      const [type] = await tx`insert into leave_types (org_id, name, days_per_year) values (${orgId}, ${"Casual"}, ${12}) returning id`;
      const typeId = Number(type?.id);
      // 101 approved leaves for other people, created first, so an unordered org-wide LIMIT 100 can drop the report's.
      for (const id of otherIds)
        await tx`insert into leave_requests (org_id, user_id, leave_type_id, start_date, end_date, status) values (${orgId}, ${id}, ${typeId}, ${"2031-03-02"}, ${"2031-03-03"}, ${"APPROVED"})`;
      await tx`insert into leave_requests (org_id, user_id, leave_type_id, start_date, end_date, status) values (${orgId}, ${reportId}, ${typeId}, ${"2031-03-04"}, ${"2031-03-05"}, ${"APPROVED"})`;
      await tx`insert into leave_requests (org_id, user_id, leave_type_id, start_date, end_date, status) values (${orgId}, ${reportId}, ${typeId}, ${"2031-03-06"}, ${"2031-03-06"}, ${"PENDING"})`;
    });
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id = any(${[ownerId, reportId, ...otherIds]})`;
    await sql.end({ timeout: 5 });
  }, 60_000);

  it("returns the report's approved leave even when the org has more than 100 in the window", async () => {
    const rows = await leaves.teamAvailability(orgId, "2031-03-01", "2031-03-15", [reportId]);

    expect(rows.map((r) => [r.userId, r.startDate, r.status])).toEqual([[reportId, "2031-03-04", "APPROVED"]]);
  });

  it("still returns only approved leave: the report's pending request is not listed", async () => {
    const rows = await leaves.teamAvailability(orgId, "2031-03-01", "2031-03-15", [reportId]);

    expect(rows.some((r) => r.startDate === "2031-03-06")).toBe(false);
  });

  it("without a report filter, keeps the org-wide behaviour of the leave calendar", async () => {
    const rows = await leaves.teamAvailability(orgId, "2031-03-01", "2031-03-15");

    expect(rows.length).toBe(100);
    expect(rows.every((r) => r.status === "APPROVED")).toBe(true);
  });
});
