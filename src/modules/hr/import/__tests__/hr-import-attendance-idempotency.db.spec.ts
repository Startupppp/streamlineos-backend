/**
 * Real-database regression for attendance-import duplication.
 *
 * Run with `pnpm test:db-specs` or:
 *   DATABASE_URL=... node ./node_modules/jest/bin/jest.js --config jest-db.json --runInBand \
 *     --testPathPattern="hr-import-attendance-idempotency.db"
 *
 * commitAttendance guarded against duplicates with `.onConflictDoNothing()`,
 * but `attendance`'s only unique indexes are on its generated serial, which the
 * insert never supplies — so no conflict could occur, the "already exists"
 * throw was unreachable, and re-running the same CSV (the ordinary correction
 * workflow, which is why the rollback endpoint exists) silently inserted every
 * row a second time.
 *
 * Only a real Postgres can show this: the claim is about which unique indexes
 * exist and therefore what ON CONFLICT can arbitrate, and a mocked db would
 * happily report the guard working. Everything is written inside a Drizzle
 * transaction that is always rolled back.
 */
import { requireApprovedDatabaseUrl } from "../../../../test/db-spec-guard";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { HrImportCommitService } from "../hr-import-commit.service";
import { importContext, stubAdmission, stubPersonEmployment } from "../import-commit-test-harness";
import { createProbeOrg, dropProbeOrg, type ProbeOrg } from "../../../../../test/helpers/probe-org";

const WORK_EMAIL = "attendance-idem-probe@synthetic.invalid";
const DATE = "2026-07-06";
const ROLLBACK = "__rollback__";

function connect() {
  const raw = requireApprovedDatabaseUrl({
    spec: "hr-import-attendance-idempotency.db.spec.ts",
    vars: ["DATABASE_URL", "APP_DATABASE_URL"],
  });
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

describe("attendance import idempotency — real database", () => {
  let client: ReturnType<typeof connect>;
  let db: Db;
  let service: HrImportCommitService;
  let probe: ProbeOrg;
  let ORG_ID: string;
  let userId: string;

  beforeAll(async () => {
    client = connect();
    db = drizzle(client, { schema });
    service = new HrImportCommitService(stubAdmission(), stubPersonEmployment());
    // Built rather than looked up: the org this suite used to name is created by no seeder in
    // the repository, so the lookup below it threw on every machine but one.
    probe = await createProbeOrg(client, "hr-import-attendance-idem");
    ORG_ID = probe.orgId;
    userId = probe.userId;
  }, 60_000);

  afterAll(async () => {
    if (client) {
      // The suite's own rows are written inside a transaction it rolls back, so the probe is
      // the only thing left to remove.
      if (probe) await dropProbeOrg(client, probe);
      await client.end({ timeout: 5 });
    }
  }, 60_000);

  it("the catalog offers ON CONFLICT no arbiter on this table beyond the serial", async () => {
    const rows = await client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'attendance' AND indexdef ILIKE '%UNIQUE%'
    `;
    // Both unique indexes are on the generated id, which the import never
    // supplies — which is exactly why onConflictDoNothing() was dead code.
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.indexdef).toMatch(/\(id\)|\(org_id, id\)/);
  });

  it("refuses the second import of the same employee and date instead of duplicating", async () => {
    let committedCount: number | undefined;
    let secondAttempt: unknown;

    await db
      .transaction(async (tx) => {
        const personKey = `attendance-idem-${Date.now()}`;
        await tx.execute(sql`
          INSERT INTO organization_people
            (organization_person_id, organization_id, first_name, last_name, work_email)
          VALUES (${personKey}, ${ORG_ID}, 'Idem', 'Probe', ${WORK_EMAIL})
        `);
        await tx.execute(sql`
          INSERT INTO hr_people (org_id, organization_person_id, user_id)
          VALUES (${ORG_ID}, ${personKey}, ${userId})
        `);

        const rowPayload = {
          employeeEmail: WORK_EMAIL,
          date: DATE,
          checkIn: `${DATE}T09:00:00Z`,
          checkOut: `${DATE}T18:00:00Z`,
          status: "PRESENT",
        };

        const first = await service.commitRow(tx, importContext(ORG_ID), "attendance", rowPayload);
        expect(first).toMatchObject({ table: "attendance" });

        // Re-running the same CSV row. Previously this inserted a second row
        // and reported success.
        secondAttempt = await service
          .commitRow(tx, importContext(ORG_ID), "attendance", rowPayload)
          .then(() => null)
          .catch((err: unknown) => err);

        const counted = await tx.execute(sql`
          SELECT count(*)::int AS count FROM attendance
           WHERE org_id = ${ORG_ID} AND user_id = ${userId} AND date = ${DATE}
        `);
        committedCount = Number(counted[0]?.count ?? -1);

        throw new Error(ROLLBACK);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === ROLLBACK) return;
        throw err;
      });

    expect(secondAttempt).toBeInstanceOf(Error);
    expect((secondAttempt as Error).message).toBe(
      `Attendance for ${WORK_EMAIL} on ${DATE} already exists`,
    );
    // One row, not two: the re-import is a refusal, not a silent duplicate.
    expect(committedCount).toBe(1);
  });
});
