/**
 * Real-database regression for attendance-import duplication.
 *
 * Guarded by HR_DB_TESTS=1. Run with:
 *   HR_DB_TESTS=1 DATABASE_URL=... npx jest --runInBand \
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
import dotenv from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../../../../db/schema";
import type { Db } from "../../../../db/drizzle.types";
import { HrImportCommitService } from "../hr-import-commit.service";

const ENABLED = process.env.HR_DB_TESTS === "1";
const describeDb = ENABLED ? describe : describe.skip;

const ORG_ID = "kbprobe-a";
const WORK_EMAIL = "attendance-idem-probe@synthetic.invalid";
const DATE = "2026-07-06";
const ROLLBACK = "__rollback__";

function connect() {
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
    dotenv.config({ path: ".env" });
  }
  const raw = process.env.DATABASE_URL || process.env.APP_DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL required for HR_DB_TESTS");
  const url = new URL(raw);
  url.searchParams.delete("channel_binding");
  const ssl = url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require";
  return postgres(url.toString(), { prepare: false, max: 4, ssl, connect_timeout: 30 });
}

describeDb("attendance import idempotency — real database", () => {
  let client: ReturnType<typeof connect>;
  let db: Db;
  let service: HrImportCommitService;
  let userId: string;

  beforeAll(async () => {
    client = connect();
    db = drizzle(client, { schema });
    service = new HrImportCommitService();

    const [member] = await client<{ user_id: string }[]>`
      SELECT m.user_id FROM organization_members m
        JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ${ORG_ID} AND u.is_active LIMIT 1
    `;
    if (!member) throw new Error(`${ORG_ID} has no active member to seed against`);
    userId = member.user_id;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

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

        const first = await service.commitRow(tx, ORG_ID, "attendance", rowPayload);
        expect(first).toMatchObject({ table: "attendance" });

        // Re-running the same CSV row. Previously this inserted a second row
        // and reported success.
        secondAttempt = await service
          .commitRow(tx, ORG_ID, "attendance", rowPayload)
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
