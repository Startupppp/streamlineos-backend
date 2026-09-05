/**
 * The catalog-and-plan half of the chat read-path release fixes.
 *
 * Everything here needs a REAL Postgres, because a mocked database confirms whatever it
 * was told to. Three of these facts are only observable in the catalog or the planner:
 *
 *   * whether `idx_chat_messages_channel_position` is partial, and therefore whether the
 *     channel-history read gets an index at all;
 *   * whether `reply_to_id` has an index, and therefore whether opening a thread is
 *     O(thread) or O(tenant);
 *   * whether `uniq_chat_channels_org_entity` refuses a second channel for one record, and
 *     whether the ON CONFLICT that names it can be inferred (a partial arbiter named
 *     without its predicate is SQLSTATE 42P10 at PLAN time — the 1054 defect).
 *
 * The CORPUS block replays the journalled migrations and needs no database, so it runs in
 * the default suite and is red without migration 1058. The CATALOG blocks are guarded by
 * CHAT_DB_TESTS=1 in the house `.db.spec.ts` style and write only inside a transaction
 * that is rolled back.
 *
 *   CHAT_DB_TESTS=1 CHAT_PROBE_DATABASE_URL=postgresql://… \
 *     npx jest --runInBand --testPathPattern="chat-read-path-hardening.db"
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { chatChannels, chatMessages, chatReplyReminders } from "../../../db/schema";
import { CHAT_ENTITY_CHANNEL_CONFLICT } from "../chat-entity-channel-conflict-target";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "migrations");
const ENABLED = process.env["CHAT_DB_TESTS"] === "1";
/**
 * DATABASE_URL ahead of APP_DATABASE_URL. The CATALOG blocks below open with a discovery read
 * (`SELECT id FROM organizations LIMIT 1`) that cannot set `app.organization_id` before it runs,
 * so under the application role row-level security empties it and the suite fails claiming the
 * database has no organisations. What these blocks pin is index shape and ON CONFLICT
 * arbitration, neither of which depends on the issuing role.
 */
const DB_URL =
  process.env["CHAT_PROBE_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  process.env["APP_DATABASE_URL"];
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

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

/**
 * `--> statement-breakpoint` is itself a `--` comment, so this must run on each chunk
 * AFTER the split, never on the whole file before it: stripping first collapses the file
 * into one chunk and a WHERE belonging to any statement makes every index look partial.
 */
function stripSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

type IndexState = { partial: boolean; unique: boolean; createdBy: string } | null;

/**
 * Replays the journal in applied order and returns the surviving definition of one index —
 * the state a database bootstrapped to head actually ends in, which is the thing that
 * drifted away from the declaration for both 1054 and 1058.
 */
function replayIndexState(indexName: string): IndexState {
  const journal: { entries: Array<{ when: number; tag: string }> } = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  );
  const ordered = [...journal.entries].sort((a, b) => a.when - b.when);
  const create = new RegExp(
    String.raw`CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?${indexName}"?`,
    "i",
  );
  const drop = new RegExp(
    String.raw`DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?${indexName}"?`,
    "i",
  );

  let state: IndexState = null;
  for (const entry of ordered) {
    const raw = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
    for (const chunk of raw.split("--> statement-breakpoint")) {
      const statement = stripSqlComments(chunk);
      if (drop.test(statement)) state = null;
      const made = create.exec(statement);
      if (made) {
        state = {
          // `WHERE` after the column list is the arbiter-defeating / plan-defeating predicate.
          partial: /\)\s*WHERE\s/i.test(statement),
          unique: Boolean(made[1]),
          createdBy: entry.tag,
        };
      }
    }
  }
  return state;
}

function declaredIndex(
  table: typeof chatMessages | typeof chatChannels | typeof chatReplyReminders,
  name: string,
) {
  const found = getTableConfig(table).indexes.find(
    (index) => (index as unknown as { config: { name: string } }).config.name === name,
  );
  return (found as unknown as { config: { unique?: boolean; where?: unknown } } | undefined)
    ?.config;
}

describe("chat read-path indexes — migration corpus agrees with the declaration", () => {
  it("idx_chat_messages_channel_position is TOTAL in both, which is what lets list() use it", () => {
    // The declaration always said total; the catalog said `WHERE is_deleted = false`, and
    // that drift is why the channel-history read (which carries no is_deleted predicate,
    // because the product renders tombstones) got a bitmap scan of the whole channel.
    expect(declaredIndex(chatMessages, "idx_chat_messages_channel_position")?.where).toBeUndefined();
    expect(replayIndexState("idx_chat_messages_channel_position")).toEqual({
      partial: false,
      unique: false,
      createdBy: "1058_chat_read_path_indexes",
    });
  });

  it("idx_chat_messages_org_reply exists and is partial on reply_to_id", () => {
    const declared = declaredIndex(chatMessages, "idx_chat_messages_org_reply");
    expect(declared).toBeDefined();
    expect(declared?.unique).toBeFalsy();
    expect(declared?.where).toBeDefined();
    expect(replayIndexState("idx_chat_messages_org_reply")).toEqual({
      partial: true,
      unique: false,
      createdBy: "1058_chat_read_path_indexes",
    });
  });

  it("uniq_chat_channels_org_entity is UNIQUE and partial in both", () => {
    const declared = declaredIndex(chatChannels, "uniq_chat_channels_org_entity");
    expect(declared?.unique).toBe(true);
    expect(declared?.where).toBeDefined();
    expect(replayIndexState("uniq_chat_channels_org_entity")).toEqual({
      partial: true,
      unique: true,
      createdBy: "1058_chat_read_path_indexes",
    });
  });

  it("the plain idx_chat_channels_org_entity it replaces is gone from the declaration", () => {
    // A plain index beside the unique one would be redundant, and its presence would mean
    // the declaration still described the shape that allowed two channels per record.
    expect(declaredIndex(chatChannels, "idx_chat_channels_org_entity")).toBeUndefined();
  });

  it("idx_chat_reply_reminders_pending exists and is partial on the pending predicate", () => {
    // Not a size optimisation: the working set is the rows the cron has NOT handled, and
    // the predicate is what keeps the index O(pending) rather than O(all history).
    const declared = declaredIndex(chatReplyReminders, "idx_chat_reply_reminders_pending");
    expect(declared).toBeDefined();
    expect(declared?.where).toBeDefined();
    expect(replayIndexState("idx_chat_reply_reminders_pending")).toEqual({
      partial: true,
      unique: false,
      createdBy: "1060_chat_reply_reminder_pending_index",
    });
    // The narrow index it sits beside is kept, not replaced.
    expect(declaredIndex(chatReplyReminders, "idx_chat_reply_reminders_due")).toBeDefined();
  });

  it("the replay can see a partial creation at all — 0980 really created one", () => {
    // Guards the three assertions above against a regex that silently matches nothing.
    const state = replayIndexState("uniq_chat_messages_client_key");
    expect(state?.partial).toBe(true);
    expect(state?.unique).toBe(true);
  });
});

describeDb("chat read-path indexes — live catalog", () => {
  let client: postgres.Sql;

  beforeAll(() => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
  });
  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  async function indexRow(name: string) {
    const [row] = await client<Array<{ pred: string | null; uniq: boolean }>>`
      SELECT pg_get_expr(x.indpred, x.indrelid) AS pred, x.indisunique AS uniq
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       WHERE i.relname = ${name}`;
    return row;
  }

  it("the catalog matches the declaration for all four", async () => {
    expect(await indexRow("idx_chat_messages_channel_position")).toEqual({ pred: null, uniq: false });
    const pending = await indexRow("idx_chat_reply_reminders_pending");
    expect(pending?.pred).toContain("sent_at");
    const reply = await indexRow("idx_chat_messages_org_reply");
    expect(reply?.pred).toContain("reply_to_id");
    const entity = await indexRow("uniq_chat_channels_org_entity");
    expect(entity?.uniq).toBe(true);
    expect(entity?.pred).toContain("entity_type");
  });

  it("the channel-history read is index-served WITHOUT an is_deleted predicate", async () => {
    // The exact shape of ChatMessageTimelineService.list. Before 1058 this planned as a
    // Bitmap Heap Scan of the whole channel plus a top-N sort; both indexes that could
    // have served the ordering were partial on `is_deleted = false`, which this query
    // deliberately does not carry.
    const plan = await client.unsafe(`
      EXPLAIN (COSTS OFF)
      SELECT id FROM chat_messages
       WHERE org_id = 'probe-org' AND channel_id = 1
       ORDER BY channel_position DESC LIMIT 51`);
    const text = plan.map((r) => String(Object.values(r)[0])).join("\n");
    expect(text).toContain("idx_chat_messages_channel_position");
    expect(text).not.toMatch(/Seq Scan|Sort Key/);
  });

  it("the due-reminder cron is index-served rather than seq-scanning every tenant's history", async () => {
    // The exact shape of ChatReplyRemindersService.processDueReminders, per org.
    const plan = await client.unsafe(`
      EXPLAIN (COSTS OFF)
      SELECT id FROM chat_reply_reminders
       WHERE org_id = 'probe-org' AND remind_at <= now()
         AND sent_at IS NULL AND cancelled_at IS NULL
       LIMIT 100`);
    const text = plan.map((r) => String(Object.values(r)[0])).join("\n");
    expect(text).toContain("idx_chat_reply_reminders_pending");
    expect(text).not.toContain("Seq Scan");
  });

  it("the thread read is index-served on reply_to_id", async () => {
    const plan = await client.unsafe(`
      EXPLAIN (COSTS OFF)
      SELECT id FROM chat_messages
       WHERE org_id = 'probe-org' AND reply_to_id = 1
       ORDER BY channel_position DESC LIMIT 51`);
    const text = plan.map((r) => String(Object.values(r)[0])).join("\n");
    expect(text).toContain("idx_chat_messages_org_reply");
    expect(text).not.toContain("Seq Scan");
  });
});

describeDb("entity channel — one record cannot get two channels", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let orgId: string;

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    const [org] = await client<Array<{ id: string }>>`SELECT id FROM organizations LIMIT 1`;
    if (!org) throw new Error("CHAT_DB_TESTS needs a database with one organizations row");
    orgId = org.id;
  });
  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  const values = (name: string) => ({
    orgId,
    name,
    type: "GROUP" as const,
    isPrivate: true,
    entityType: "ticket",
    entityId: "probe-42",
  });

  it("the second insert for the same record yields no row, and the first survives", async () => {
    await client.unsafe("BEGIN");
    const observed = await (async () => {
      try {
        const first = await db.insert(chatChannels).values(values("first")).returning();
        // The conflict target names the PARTIAL index's predicate. Without it this line is
        // SQLSTATE 42P10 at plan time, which is the failure mode `sqlstate` reports below.
        const second = await db
          .insert(chatChannels)
          .values(values("racer"))
          .onConflictDoNothing(CHAT_ENTITY_CHANNEL_CONFLICT)
          .returning();
        const [{ count }] = await client<Array<{ count: string }>>`
          SELECT count(*) AS count FROM chat_channels
           WHERE org_id = ${orgId} AND entity_type = 'ticket' AND entity_id = 'probe-42'`;
        return {
          sqlstate: undefined as string | undefined,
          firstRows: first.length,
          secondRows: second.length,
          stored: Number(count),
        };
      } catch (error) {
        return { sqlstate: sqlstateOf(error) ?? String(error), firstRows: -1, secondRows: -1, stored: -1 };
      } finally {
        await client.unsafe("ROLLBACK");
      }
    })();

    expect(observed).toEqual({ sqlstate: undefined, firstRows: 1, secondRows: 0, stored: 1 });
  });

  it("a channel with no entity is unaffected — the index is partial for a reason", async () => {
    await client.unsafe("BEGIN");
    const observed = await (async () => {
      try {
        const plain = { orgId, name: "plain", type: "GROUP" as const, isPrivate: true };
        await db.insert(chatChannels).values(plain);
        await db.insert(chatChannels).values(plain);
        const [{ count }] = await client<Array<{ count: string }>>`
          SELECT count(*) AS count FROM chat_channels
           WHERE org_id = ${orgId} AND name = 'plain'`;
        return { sqlstate: undefined as string | undefined, stored: Number(count) };
      } catch (error) {
        return { sqlstate: sqlstateOf(error) ?? String(error), stored: -1 };
      } finally {
        await client.unsafe("ROLLBACK");
      }
    })();

    // A total unique index over (org_id, entity_type, entity_id) would have refused the
    // second of these, because NULL = NULL does not collide but the partial predicate is
    // what keeps entity-less channels out of the uniqueness class entirely.
    expect(observed).toEqual({ sqlstate: undefined, stored: 2 });
  });
});
