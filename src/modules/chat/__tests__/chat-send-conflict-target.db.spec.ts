/**
 * The regression net for the P0 that broke every chat send at journal head.
 *
 * `uniq_chat_messages_client_key` is PARTIAL — `WHERE client_key IS NOT NULL`,
 * migration 0980. The send path named its three columns with no arbiter
 * predicate, so Postgres could not infer the index and raised SQLSTATE 42P10 at
 * PLAN time. Plan time matters: the failure needed no colliding row, no client
 * key and no concurrency. `POST /chat/channels/:id/messages` returned 500 for
 * every caller, always.
 *
 * A mocked database cannot see this. `chat-send-idempotency.spec.ts` asserts the
 * conflict target and passed against the broken value, because index inference
 * happens inside Postgres and a fake answers whatever it was told to answer.
 * So this spec has two halves, and the first one runs everywhere:
 *
 *   HERMETIC — compiles the production conflict spec into SQL and asserts the
 *   emitted `on conflict` clause carries a predicate whenever the declared index
 *   it arbitrates is partial. No database. This alone would have caught it, and
 *   it also catches the drizzle-orm 0.45.2 trap that `onConflictDoNothing` reads
 *   `where` while `onConflictDoUpdate` reads `targetWhere` — a `targetWhere`
 *   passed to the former is silently dropped and re-emits the broken SQL.
 *
 *   CATALOG — executes the real statement against a real partial index and
 *   proves both directions: the head form raises 42P10, the shipped form does
 *   not, a retry on the same key is a no-op, and null keys still insert. Guarded
 *   by CHAT_DB_TESTS=1 in the house `.db.spec.ts` style. Everything runs inside a
 *   transaction that is rolled back, so the database is left as it was found.
 *
 *     CHAT_DB_TESTS=1 CHAT_PROBE_DATABASE_URL=postgresql://… \
 *       npx jest --runInBand --testPathPattern="chat-send-conflict-target"
 */
import { randomUUID } from "node:crypto";
import { and, eq, getTableName, type SQL } from "drizzle-orm";
import { getTableConfig, type IndexColumn } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { chatChannels, chatMessages } from "../../../db/schema";
import { CHAT_MESSAGE_CLIENT_KEY_CONFLICT } from "../chat-message-conflict-target";

/**
 * The parameter `onConflictDoNothing` actually takes in drizzle-orm 0.45.2. Written out
 * rather than derived from the builder: `db.insert(t)` returns a PgInsertBuilder, which
 * has no `onConflictDoNothing` until `.values()` has been applied, so deriving it from
 * `typeof db.insert` does not compile — the mistake `check:spec-typecheck` caught.
 */
type ConflictSpec = { target: IndexColumn[]; where?: SQL };

/** The exact value that shipped at journal head, kept so the net proves it bites. */
const HEAD_FORM: ConflictSpec = {
  target: [chatMessages.orgId, chatMessages.channelId, chatMessages.clientKey],
};

const ENABLED = process.env.CHAT_DB_TESTS === "1";
const DB_URL = process.env.CHAT_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

class Rollback extends Error {}

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

function clientKeyIndex() {
  const declared = getTableConfig(chatMessages).indexes.find(
    (index) => (index as unknown as { config: { name: string } }).config.name === "uniq_chat_messages_client_key",
  );
  return (declared as unknown as { config: { unique?: boolean; where?: unknown } } | undefined)?.config;
}

describe("chat send conflict target — hermetic", () => {
  it("the index it arbitrates is unique AND partial, which is what makes a bare target 42P10", () => {
    const index = clientKeyIndex();
    expect(index).toBeDefined();
    expect(index?.unique).toBe(true);
    expect(index?.where).toBeDefined();
  });

  it("the production conflict spec emits an arbiter predicate, and the head form does not", () => {
    const offline = drizzle(postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 }));
    const compile = (config: ConflictSpec) =>
      offline
        .insert(chatMessages)
        .values({ orgId: "o", channelId: 1, content: "x", clientKey: "k", channelPosition: 0 })
        .onConflictDoNothing(config)
        .toSQL().sql;

    const shipped = compile(CHAT_MESSAGE_CLIENT_KEY_CONFLICT);
    const head = compile(HEAD_FORM);

    expect(head).toContain(`on conflict ("org_id","channel_id","client_key") do nothing`);
    expect(shipped).toMatch(/on conflict \("org_id","channel_id","client_key"\) where .*client_key.* do nothing/);
    expect(shipped).not.toContain(`"client_key") do nothing`);
  });

  it("spells the arbiter predicate the key onConflictDoNothing actually reads", () => {
    // drizzle-orm 0.45.2: onConflictDoNothing takes { target, where }; only
    // onConflictDoUpdate takes targetWhere. A targetWhere here is dropped in silence.
    expect(Object.keys(CHAT_MESSAGE_CLIENT_KEY_CONFLICT).sort()).toEqual(["target", "where"]);
  });
});

describeDb("chat send conflict target — real partial index", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let orgId: string;
  let channelId: number;

  beforeAll(async () => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client);
    const [row] = await db
      .select({ orgId: chatChannels.orgId, id: chatChannels.id })
      .from(chatChannels)
      .limit(1);
    if (!row) throw new Error("CHAT_DB_TESTS needs a database with at least one chat_channels row");
    orgId = row.orgId;
    channelId = row.id;
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("the live index really is partial, so this is not testing a different database", async () => {
    const [row] = await client<Array<{ pred: string | null }>>`
      SELECT pg_get_expr(x.indpred, x.indrelid) AS pred
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
       WHERE i.relname = 'uniq_chat_messages_client_key'`;
    expect(row?.pred).toMatch(/client_key IS NOT NULL/i);
    expect(getTableName(chatMessages)).toBe("chat_messages");
  });

  it("the head form raises 42P10 — a bare target cannot arbitrate a partial index", async () => {
    const captured = await db
      .transaction(async (tx) => {
        await tx
          .insert(chatMessages)
          .values({ orgId, channelId, content: "p0", clientKey: `p0-${randomUUID()}`, channelPosition: 0 })
          .onConflictDoNothing(HEAD_FORM)
          .returning();
        throw new Rollback();
      })
      .then(() => undefined)
      .catch((error: unknown) => (error instanceof Rollback ? undefined : sqlstateOf(error)));

    expect(captured).toBe("42P10");
  });

  it("the shipped form plans, dedupes a retry, and leaves null client keys alone", async () => {
    const key = `p0-${randomUUID()}`;
    const values = { orgId, channelId, content: "p0", channelPosition: 0 };
    const observed = await db
      .transaction(async (tx) => {
        const insert = (clientKey: string | null) =>
          tx
            .insert(chatMessages)
            .values({ ...values, clientKey })
            .onConflictDoNothing(CHAT_MESSAGE_CLIENT_KEY_CONFLICT)
            .returning({ id: chatMessages.id });

        const first = await insert(key);
        const retry = await insert(key);
        const nullA = await insert(null);
        const nullB = await insert(null);
        const persisted = await tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(and(eq(chatMessages.orgId, orgId), eq(chatMessages.clientKey, key)));

        const result = {
          first: first.length,
          retry: retry.length,
          nullA: nullA.length,
          nullB: nullB.length,
          persisted: persisted.length,
        };
        throw Object.assign(new Rollback(), { result });
      })
      .then(() => undefined)
      .catch((error: unknown) => {
        if (error instanceof Rollback) return (error as Rollback & { result: Record<string, number> }).result;
        throw error;
      });

    expect(observed).toEqual({ first: 1, retry: 0, nullA: 1, nullB: 1, persisted: 1 });
  });

  it("leaves nothing behind", async () => {
    const [row] = await client<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM chat_messages WHERE client_key LIKE 'p0-%'`;
    expect(row?.n).toBe(0);
  });
});
