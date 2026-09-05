/**
 * `GET /sessions` is the "active devices" list in Settings → Security, and it
 * was neither filtered by expiry nor bounded.
 *
 * `SessionsService.list` filtered on `(user_id, is_revoked = false)` only — no
 * `expires_at` predicate, no `.limit()`. Three facts made that bite:
 *
 *  1. `organizations.max_concurrent_sessions` is nullable with no default
 *     (verified against `information_schema.columns`), so
 *     `auth-membership-resolver.service.ts:135-137` never calls
 *     `enforceMaxSessions` and nothing revokes anything by default.
 *  2. Nothing prunes: no code path deletes a `user_sessions` row.
 *  3. `list()` itself INSERTS a row for any unseen `currentSessionId`.
 *
 * So the list grew one row per sign-in forever, and every row rendered as a
 * live device with a working Revoke button. The asymmetry was inside this one
 * file: `enforceMaxSessions` at :193-201 already filters
 * `or(isNull(expiresAt), gt(expiresAt, now))`; `list()` did not. The admin twin
 * `user-profile.service.ts:71` is the same query with `.limit(50)`.
 *
 * Which rows a predicate actually excludes, and whether a cap is real, are
 * facts about Postgres — a mocked `findMany` answers whatever it was told. So
 * this seeds real rows and calls the real service. Fixtures carry a unique id
 * prefix and are deleted in `finally`, leaving the database as it was found.
 *
 *   SESSIONS_DB_TESTS=1 DATABASE_URL=postgresql://… \
 *     npx jest --runInBand --testPathPattern="sessions-list-bounds.db"
 */
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// The namespace is what `drizzle(client, { schema })` needs to produce a value
// of type `Db`. No CRM identity table is referenced here — only `user_sessions`
// and a read of `users` to pick a subject.
// eslint-disable-next-line no-restricted-imports -- namespace needed for the Db type; no CRM identity table is referenced here
import * as schema from "../../db/schema";
import { userSessions, users } from "../../db/schema";
import { SESSION_LIST_CAP, SessionsService } from "./sessions.service";
import { MeService } from "../../me/me.service";
import { EmploymentFactsService } from "../../modules/directory/employment-facts.service";

const ENABLED = process.env.SESSIONS_DB_TESTS === "1";
const DB_URL = process.env.SESSIONS_PROBE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const describeDb = ENABLED && DB_URL !== "" ? describe : describe.skip;

describe("SessionsService.list — cap constant", () => {
  it("SESSION_LIST_CAP is 50, matching the admin getUserSessions twin that has always read .limit(50)", () => {
    expect(SESSION_LIST_CAP).toBe(50);
  });
});

if (ENABLED) jest.setTimeout(180_000);

const SUFFIX = randomUUID().slice(0, 8);
const ID_PREFIX = `sesslist-${SUFFIX}-`;
const HOUR = 60 * 60 * 1000;

describeDb("SessionsService.list — expiry and bound, against a real database", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let userId: string;

  beforeAll(async () => {
    client = postgres(DB_URL, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    db = drizzle(client, { schema });
    const [subject] = await db.select({ id: users.id }).from(users).limit(1);
    if (!subject) throw new Error("probe needs at least one users row");
    userId = subject.id;
  });

  afterAll(async () => {
    try {
      await db.delete(userSessions).where(like(userSessions.id, `${ID_PREFIX}%`));
    } finally {
      await client.end();
    }
  });

  afterEach(async () => {
    await db.delete(userSessions).where(like(userSessions.id, `${ID_PREFIX}%`));
  });

  const service = (): SessionsService => new SessionsService(db, null);

  /** `list()` upserts whatever id it is handed, so probe with a seeded one. */
  const seed = async (
    rows: { suffix: string; expiresAt: Date | null; lastActive: Date }[],
  ): Promise<void> => {
    await db.insert(userSessions).values(
      rows.map((row) => ({
        id: `${ID_PREFIX}${row.suffix}`,
        userId,
        userAgent: "probe",
        ipAddress: null,
        isRevoked: false,
        lastActive: row.lastActive,
        expiresAt: row.expiresAt,
      })),
    );
  };

  it("excludes an expired session and keeps a live one and a never-expiring one", async () => {
    const now = Date.now();
    await seed([
      { suffix: "expired", expiresAt: new Date(now - HOUR), lastActive: new Date(now - 3 * HOUR) },
      { suffix: "live", expiresAt: new Date(now + HOUR), lastActive: new Date(now - 2 * HOUR) },
      { suffix: "forever", expiresAt: null, lastActive: new Date(now - HOUR) },
    ]);

    const listed = await service().list(userId, `${ID_PREFIX}live`, "probe", undefined);
    const ids = listed.map((s) => s.id);

    expect(ids).toContain(`${ID_PREFIX}live`);
    // A row with no expiry never expires, so it must survive the predicate —
    // `enforceMaxSessions` treats it the same way.
    expect(ids).toContain(`${ID_PREFIX}forever`);
    // The device the user actually signed out of a month ago.
    expect(ids).not.toContain(`${ID_PREFIX}expired`);
  });

  it("ANTI-VACUITY: the expired row is really in the table, so the filter is doing the work", async () => {
    const now = Date.now();
    await seed([
      { suffix: "expired", expiresAt: new Date(now - HOUR), lastActive: new Date(now - HOUR) },
    ]);
    const stored = await db
      .select({ id: userSessions.id })
      .from(userSessions)
      .where(eq(userSessions.id, `${ID_PREFIX}expired`));
    expect(stored).toHaveLength(1);

    const listed = await service().list(userId, `${ID_PREFIX}expired`, "probe", undefined);
    // Even as the CURRENT session id, an expired row is not an active device.
    expect(listed.map((s) => s.id)).not.toContain(`${ID_PREFIX}expired`);
  });

  it("caps the list rather than returning one row per sign-in forever", async () => {
    const now = Date.now();
    const overCap = SESSION_LIST_CAP + 25;
    await seed(
      Array.from({ length: overCap }, (_unused, index) => ({
        suffix: `bulk-${String(index).padStart(4, "0")}`,
        expiresAt: new Date(now + 30 * 24 * HOUR),
        lastActive: new Date(now - index * 1000),
      })),
    );

    const listed = await service().list(userId, `${ID_PREFIX}bulk-0000`, "probe", undefined);

    expect(overCap).toBeGreaterThan(SESSION_LIST_CAP);
    expect(listed).toHaveLength(SESSION_LIST_CAP);
    // Most-recent-first, so the current device is never the row that falls off.
    expect(listed[0]?.id).toBe(`${ID_PREFIX}bulk-0000`);
    expect(listed.some((s) => s.isCurrent)).toBe(true);
  });

  it("is deterministic under the cap — the same state lists the same rows twice", async () => {
    const now = Date.now();
    // Identical `last_active` on every row: without a tiebreak the cap would
    // return an arbitrary subset, and a different one on a plan change.
    const tied = new Date(now - HOUR);
    await seed(
      Array.from({ length: SESSION_LIST_CAP + 10 }, (_unused, index) => ({
        suffix: `tie-${String(index).padStart(4, "0")}`,
        expiresAt: new Date(now + 30 * 24 * HOUR),
        lastActive: tied,
      })),
    );

    const first = await service().list(userId, "", undefined, undefined);
    const second = await service().list(userId, "", undefined, undefined);

    expect(first).toHaveLength(SESSION_LIST_CAP);
    expect(second.map((s) => s.id)).toEqual(first.map((s) => s.id));
  });

  /**
   * `MeService.getAuthAnalytics` reports `activeSessions` beside this list, and it carried the
   * SAME missing expiry predicate. Filtering only the list would leave the screen contradicting
   * itself — "3 active sessions" over two rows — so the count has to mean the same thing the list
   * means.
   */
  it("the /me activeSessions count agrees with the list about what is active", async () => {
    const now = Date.now();
    await seed([
      { suffix: "expired-a", expiresAt: new Date(now - HOUR), lastActive: new Date(now - 4 * HOUR) },
      { suffix: "expired-b", expiresAt: new Date(now - 2 * HOUR), lastActive: new Date(now - 5 * HOUR) },
      { suffix: "live", expiresAt: new Date(now + HOUR), lastActive: new Date(now - HOUR) },
      { suffix: "forever", expiresAt: null, lastActive: new Date(now - 2 * HOUR) },
    ]);

    const listed = await service().list(userId, `${ID_PREFIX}live`, "probe", undefined);
    // Constructed for real rather than cast from a stub — `getAuthAnalytics` never touches it,
    // and a real collaborator cannot drift out of the constructor's shape.
    const { activeSessions } = await new MeService(
      db,
      new EmploymentFactsService(db),
    ).getAuthAnalytics(userId);

    // Two live rows, two expired ones. A count that still says 4 is the same defect one read over.
    expect(listed).toHaveLength(2);
    expect(activeSessions).toBe(listed.length);
  });
});
