/**
 * HRMS-E2E-014, against a real Postgres.
 *
 * The resolver beside this file is pure and fully asserted. What a unit test
 * cannot show is whether the SQL underneath it behaves: the approval path now
 * opens a balance row with `onConflictDoNothing`, and that is only safe if the
 * conflict target is a unique index Postgres actually has. `leave_balances`
 * carries `uniq_leave_balances_user_type_year` on `(user_id, leave_type_id,
 * year)` — note it is keyed on `user_id`, not `user_membership_id`, which is the
 * column the reads filter by. Getting that wrong would either duplicate rows on
 * a concurrent approval or throw 23505 in the middle of one.
 *
 * These assertions run the real statements against real tables.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="leave-entitlement"
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { leaveBalances, leaveTypes } from "../../../db/schema";
import { openingEntitlementOf, resolveLeaveBalances } from "./leave-entitlement";

const describeDb = dbSpecSuite();

describeDb("leave entitlement — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "leave-entitlement.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const orgId = `qa-entitle-${randomUUID()}`;
  const userId = `qa-entitle-user-${randomUUID()}`;
  let membershipId = 0;
  let casualId = 0;
  let sickId = 0;
  const YEAR = 2026;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });

    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${userId}, ${`${userId}@example.com`}, ${"QA Entitlement"})`;
      const [row] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
      membershipId = Number(row?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Entitlement Co"}, ${orgId}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${orgId}, ${userId}, ${"OWNER"}, ${"ACTIVE"}, true)
      `;
    });

    const [casual] = await sql`
      insert into leave_types (org_id, name, days_per_year)
      values (${orgId}, ${"QA Casual Leave"}, 12) returning id
    `;
    casualId = Number(casual?.id);
    const [sick] = await sql`
      insert into leave_types (org_id, name, days_per_year)
      values (${orgId}, ${"Sick Leave"}, 6) returning id
    `;
    sickId = Number(sick?.id);
  }, 30_000);

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from leave_balances where org_id = ${orgId}`;
    await sql`delete from leave_types where org_id = ${orgId}`;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  }, 30_000);

  async function readTypes() {
    return db.query.leaveTypes.findMany({
      where: eq(leaveTypes.orgId, orgId),
      columns: { id: true, name: true, daysPerYear: true },
      limit: 50,
    });
  }

  async function readStored() {
    return db.query.leaveBalances.findMany({
      where: and(
        eq(leaveBalances.userMembershipId, membershipId),
        eq(leaveBalances.orgId, orgId),
        eq(leaveBalances.year, YEAR),
      ),
      limit: 50,
    });
  }

  it("a configured policy with no rows yet reads as its full entitlement", async () => {
    // The exact state QA was in: two types configured, nobody has taken leave,
    // and the old read returned an empty list that the UI called "no policy".
    const resolved = resolveLeaveBalances(await readTypes(), await readStored());

    expect(resolved).toHaveLength(2);
    expect(resolved.find((row) => row.leaveTypeId === casualId)).toEqual({
      leaveTypeId: casualId,
      balance: "12.00",
      isOpeningEntitlement: true,
    });
    expect(resolved.find((row) => row.leaveTypeId === sickId)?.balance).toBe("6.00");
  });

  it("opens a balance row at the entitlement, the way an approval does", async () => {
    const [type] = await readTypes();
    const casual = (await readTypes()).find((row) => row.id === casualId) ?? type;

    await db
      .insert(leaveBalances)
      .values({
        orgId,
        userId,
        userMembershipId: membershipId,
        leaveTypeId: casualId,
        balance: openingEntitlementOf(casual),
        year: YEAR,
      })
      .onConflictDoNothing();

    const stored = await readStored();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.balance).toBe("12.00");
  });

  it("a second approval racing the first does not duplicate the row or throw", async () => {
    // The whole reason the insert is onConflictDoNothing. The unique index is on
    // (user_id, leave_type_id, year) — not the membership column the reads use —
    // so this is the assertion that the conflict target is the real one.
    const casual = (await readTypes()).find((row) => row.id === casualId);
    if (!casual) throw new Error("fixture lost its leave type");

    await expect(
      db
        .insert(leaveBalances)
        .values({
          orgId,
          userId,
          userMembershipId: membershipId,
          leaveTypeId: casualId,
          balance: openingEntitlementOf(casual),
          year: YEAR,
        })
        .onConflictDoNothing(),
    ).resolves.not.toThrow();

    expect(await readStored()).toHaveLength(1);
  });

  it("a deduction survives the read: the stored row wins over the entitlement", async () => {
    // Approve two days against the twelve.
    await db
      .update(leaveBalances)
      .set({ balance: "10.00" })
      .where(
        and(
          eq(leaveBalances.orgId, orgId),
          eq(leaveBalances.leaveTypeId, casualId),
          eq(leaveBalances.year, YEAR),
        ),
      );

    const resolved = resolveLeaveBalances(await readTypes(), await readStored());
    const casual = resolved.find((row) => row.leaveTypeId === casualId);

    expect(casual).toEqual({
      leaveTypeId: casualId,
      balance: "10.00",
      isOpeningEntitlement: false,
    });
    // The type with no row is still reported, so one deduction does not hide
    // every other policy the organisation has.
    expect(resolved.find((row) => row.leaveTypeId === sickId)?.balance).toBe("6.00");
  });
});
