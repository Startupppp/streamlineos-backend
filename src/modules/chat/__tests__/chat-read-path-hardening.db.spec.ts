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
 * The migration corpus block is in `chat-read-path-hardening.spec.ts` (default suite).
 * Every block here writes only inside a transaction that is rolled back.
 *
 *   CHAT_PROBE_DATABASE_URL=postgresql://… \
 *     node ./node_modules/jest/bin/jest.js --config ./jest-db.json --runInBand \
 *       --testPathPattern="chat-read-path-hardening.db"
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../../db/schema";
import { chatChannels } from "../../../db/schema";
import { CHAT_ENTITY_CHANNEL_CONFLICT } from "../chat-entity-channel-conflict-target";

const DB_URL =
  process.env["CHAT_PROBE_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  process.env["APP_DATABASE_URL"];
if (!DB_URL)
  throw new Error("CHAT_PROBE_DATABASE_URL (or DATABASE_URL) is required to run this suite");

function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("chat read-path indexes — live catalog", () => {
  let client: postgres.Sql;

  beforeAll(() => {
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
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

describe("entity channel — one record cannot get two channels", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let orgId: string;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
    const [org] = await client<Array<{ id: string }>>`SELECT id FROM organizations LIMIT 1`;
    if (!org) throw new Error("this suite needs a database with at least one organizations row");
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

    expect(observed).toEqual({ sqlstate: undefined, stored: 2 });
  });
});
