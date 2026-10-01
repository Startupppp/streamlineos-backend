/**
 * The behaviour migrations 1705 and 1706 claim, asserted against a real database.
 *
 * Both were journalled (idx 1160 / 1161) and had never been executed anywhere. 1706's
 * fix for BUG-TS-BE-006 — "a voided entry kept holding its day, so the next entry for
 * that date failed with 23505" — had only ever been asserted at declaration level, which
 * reads the migration's own text back and cannot tell a narrowed predicate from a widened
 * one. 1705's UPDATE ran against zero rows on a cold database, so applying it is not
 * evidence that it moves the periods it is meant to move and nothing else.
 *
 *   ALLOW_DESTRUCTIVE_DB_TESTS=1 DATABASE_URL=postgresql://…@127.0.0.1:5432/<scratch> \
 *     pnpm test:db-specs --testPathPattern="timesheets-work-log-unique.db"
 *
 * Every write is rolled back.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dbSpecClient, dbSpecSuite, dbSpecUrl } from "../../../test/db-spec-gate";

const describeDb = dbSpecSuite(["DATABASE_URL"]);

const ORG = "orgA";
const OWNER = 1; // organization_members.id of the fixture manager

function sqlStateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describeDb("1706 — uniq_timesheets_work_log excludes voided rows", () => {
  const sql = dbSpecClient(dbSpecUrl("DATABASE_URL"), { max: 1 });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("carries the predicate the migration wrote, read back from the catalog", async () => {
    const [row] = await sql`
      SELECT pg_get_indexdef(i.oid) AS def
        FROM pg_class i
        JOIN pg_namespace n ON n.oid = i.relnamespace
       WHERE n.nspname = 'public' AND i.relname = 'uniq_timesheets_work_log'`;
    expect(String(row?.def)).toContain("(ticket_id IS NULL) AND (voided_at IS NULL)");
  });

  it("lets a new entry take a day whose only existing entry is voided — BUG-TS-BE-006", async () => {
    const day = "2026-07-02";
    const result = await sql
      .begin(async (tx) => {
        await tx`
          INSERT INTO timesheets (org_id, user_membership_id, date, hours, voided_at, void_reason)
          VALUES (${ORG}, ${OWNER}, ${day}, 4, now(), 'superseded')`;
        await tx`
          INSERT INTO timesheets (org_id, user_membership_id, date, hours)
          VALUES (${ORG}, ${OWNER}, ${day}, 8)`;
        const rows = await tx`
          SELECT count(*)::int AS n FROM timesheets
           WHERE org_id = ${ORG} AND user_membership_id = ${OWNER} AND date = ${day}`;
        throw Object.assign(new Error("rollback"), { n: rows[0]?.n });
      })
      .catch((e: Error & { n?: number }) => e);

    // Positive half (BE-141): both inserts landed, so the day really does hold a voided
    // row and a live one at once. A 23505 here is the defect BUG-TS-BE-006 describes.
    expect(sqlStateOf(result)).toBeUndefined();
    expect(result.n).toBe(2);
  });

  it("rejects two live ticketless entries for the same day, before and after voiding one", async () => {
    const day = "2026-07-03";
    const outcome = await sql
      .begin(async (tx) => {
        await tx`INSERT INTO timesheets (org_id, user_membership_id, date, hours) VALUES (${ORG}, ${OWNER}, ${day}, 4)`;
        await tx`INSERT INTO timesheets (org_id, user_membership_id, date, hours) VALUES (${ORG}, ${OWNER}, ${day}, 4)`;
      })
      .then(() => "accepted")
      .catch((e) => sqlStateOf(e));
    expect(outcome).toBe("23505");
  });
});

describeDb("1705 — APPROVED periods holding locked_at become LOCKED", () => {
  const sql = dbSpecClient(dbSpecUrl("DATABASE_URL"), { max: 1 });
  const body = readFileSync(
    join(__dirname, "../../../../migrations/1705_timesheet_periods_locked_status_repair.sql"),
    "utf8",
  );

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("moves an APPROVED period with locked_at, leaves one without it, and does not touch event_seq", async () => {
    const statement = body
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => /^\s*(--.*\n)*\s*UPDATE/m.test(s))
      .join("\n");
    expect(statement).toContain("UPDATE");

    const result = await sql
      .begin(async (tx) => {
        const before = await tx`
          SELECT id, status::text AS status, event_seq FROM timesheet_periods
           WHERE org_id = ${ORG} AND id IN (5, 6) ORDER BY id`;
        // The fixture holds 5 = APPROVED + locked_at, 6 = APPROVED without it. If the
        // chain already moved 5 to LOCKED, reset it so the statement has work to do.
        await tx`UPDATE timesheet_periods SET status = 'APPROVED' WHERE org_id = ${ORG} AND id = 5`;
        await tx.unsafe(statement);
        const after = await tx`
          SELECT id, status::text AS status, event_seq FROM timesheet_periods
           WHERE org_id = ${ORG} AND id IN (5, 6) ORDER BY id`;
        throw Object.assign(new Error("rollback"), { before, after });
      })
      .catch((e: Error & { before?: unknown[]; after?: unknown[] }) => e);

    const after = result.after as { id: number; status: string; event_seq: number }[];
    const before = result.before as { id: number; status: string; event_seq: number }[];
    expect(after.find((r) => r.id === 5)?.status).toBe("LOCKED");
    expect(after.find((r) => r.id === 6)?.status).toBe("APPROVED");
    expect(after.find((r) => r.id === 5)?.event_seq).toBe(before.find((r) => r.id === 5)?.event_seq);
  });
});
