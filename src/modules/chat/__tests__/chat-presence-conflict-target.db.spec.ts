/**
 * The regression net for the P0 that broke every chat presence write at journal head.
 *
 * Same defect class as `chat-send-conflict-target.db.spec.ts`, one table over, and
 * the commit that fixed chat_messages (08b9274c4) did not touch presence.
 *
 * `chat_user_presence` DECLARES a total unique index over (org_id, membership_id)
 * — `uniqueIndex("uniq_chat_presence_org_membership")`, no `.where()`. The only
 * journalled statement that ever created it, migration 0713, created it PARTIAL:
 *
 *   CREATE UNIQUE INDEX ... ON chat_user_presence (org_id, membership_id)
 *     WHERE membership_id IS NOT NULL;
 *
 * Both production upserts — `ChatPresenceService.heartbeat` and `.setStatus` —
 * name the two columns with no arbiter predicate, because the declaration says
 * they do not need one. Postgres cannot infer a partial index from a bare target,
 * so both statements raise SQLSTATE 42P10 at PLAN time: no colliding row, no
 * concurrency and no data of any kind is required, and `POST /chat/presence/
 * heartbeat` plus `PUT /chat/status` 500 for every caller in every tenant.
 *
 * WHICH SIDE IS WRONG. The declaration. Migration 0762 made membership_id NOT
 * NULL, so the predicate excludes nothing — and even on a database where it were
 * still nullable a *unique* index over a key containing that column enforces
 * exactly the same thing either way, because NULL keys never collide in a btree.
 * The partial and total forms are indistinguishable as constraints; they differ
 * only in whether `ON CONFLICT (org_id, membership_id)` can find them. So the
 * catalog is corrected to match the declaration (migration 1054) rather than the
 * two call sites being taught to carry a vacuous predicate.
 *
 *   CATALOG — executes the REAL ChatPresenceService against a real database and
 *   proves both directions: at head the two routes raise 42P10, after the fix they
 *   upsert and are idempotent. Every write happens inside a transaction that is
 *   rolled back, so the database is left as it was found.
 *
 *   DATABASE_URL=postgresql://… \
 *     pnpm test:db-specs --testNamePattern="chat presence conflict target — real catalog"
 */
import { and, eq, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { chatUserPresence, organizationMembers } from "../../../db/schema";
import { ChatPresenceService } from "../chat-presence.service";

const INDEX_NAME = "uniq_chat_presence_org_membership";

const DB_URL =
  process.env.CHAT_PROBE_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.APP_DATABASE_URL;
if (!DB_URL)
  throw new Error(
    "chat-presence-conflict-target.db.spec requires CHAT_PROBE_DATABASE_URL, DATABASE_URL, or APP_DATABASE_URL",
  );

/** Drizzle wraps driver errors: `err.code` is undefined and the SQLSTATE is on `.cause`. */
function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("chat presence conflict target — real catalog", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let service: ChatPresenceService;
  let orgId: string;
  let userId: string;
  let membershipId: number;
  let rowsBefore: number;

  beforeAll(async () => {
    // max: 1 — every statement below shares one connection, so the BEGIN/ROLLBACK
    // issued out of band really does wrap the service's own autocommit writes.
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    service = new ChatPresenceService(db);
    const [member] = await db
      .select({
        orgId: organizationMembers.orgId,
        userId: organizationMembers.userId,
        id: organizationMembers.id,
      })
      .from(organizationMembers)
      .where(eq(organizationMembers.status, "ACTIVE"))
      .limit(1);
    if (!member) throw new Error("chat-presence-conflict-target.db.spec needs a database with one ACTIVE organization_members row");
    orgId = member.orgId;
    userId = member.userId;
    membershipId = member.id;
    const existing = await db
      .select({ id: chatUserPresence.id })
      .from(chatUserPresence)
      .where(and(eq(chatUserPresence.orgId, orgId), eq(chatUserPresence.membershipId, membershipId)));
    rowsBefore = existing.length;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("the live index is TOTAL, so this is not testing a different database", async () => {
    const [row] = await client<Array<{ pred: string | null }>>`
      SELECT pg_get_expr(x.indpred, x.indrelid) AS pred
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
       WHERE i.relname = ${INDEX_NAME}`;
    expect(row).toBeDefined();
    expect(row?.pred).toBeNull();
    expect(getTableName(chatUserPresence)).toBe("chat_user_presence");
  });

  it("heartbeat and setStatus plan and are idempotent — the head form raised 42P10 here", async () => {
    await client.unsafe("BEGIN");
    const observed = await (async () => {
      try {
        await service.heartbeat(userId, orgId);
        await service.heartbeat(userId, orgId);
        await service.setStatus(userId, orgId, { status: "AWAY" });
        const rows = await db
          .select({ status: chatUserPresence.status })
          .from(chatUserPresence)
          .where(and(eq(chatUserPresence.orgId, orgId), eq(chatUserPresence.membershipId, membershipId)));
        return { error: undefined, rows: rows.length, status: rows[0]?.status };
      } catch (error) {
        return { error: sqlstateOf(error) ?? String(error), rows: -1, status: undefined };
      } finally {
        await client.unsafe("ROLLBACK");
      }
    })();

    // One row after three upserts proves the target arbitrated rather than duplicated.
    expect(observed).toEqual({ error: undefined, rows: 1, status: "AWAY" });
  });

  it("leaves nothing behind", async () => {
    const rows = await db
      .select({ id: chatUserPresence.id })
      .from(chatUserPresence)
      .where(and(eq(chatUserPresence.orgId, orgId), eq(chatUserPresence.membershipId, membershipId)));
    expect(rows.length).toBe(rowsBefore);
  });
});
