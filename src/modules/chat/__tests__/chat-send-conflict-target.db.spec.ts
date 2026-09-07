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
 * The hermetic half is in `chat-send-conflict-target.spec.ts`. Everything here
 * executes against a real partial index inside a transaction that is rolled back.
 *
 *   CHAT_PROBE_DATABASE_URL=postgresql://… \
 *     node ./node_modules/jest/bin/jest.js --config ./jest-db.json --runInBand \
 *       --testPathPattern="chat-send-conflict-target.db"
 */
import { randomUUID } from "node:crypto";
import { and, eq, getTableName, type SQL } from "drizzle-orm";
import { type IndexColumn } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { chatChannels, chatMessages } from "../../../db/schema";
import { CHAT_MESSAGE_CLIENT_KEY_CONFLICT } from "../chat-message-conflict-target";

type ConflictSpec = { target: IndexColumn[]; where?: SQL };

const HEAD_FORM: ConflictSpec = {
  target: [chatMessages.orgId, chatMessages.channelId, chatMessages.clientKey],
};

const DB_URL =
  process.env.CHAT_PROBE_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.APP_DATABASE_URL;
if (!DB_URL) throw new Error("CHAT_PROBE_DATABASE_URL (or DATABASE_URL) is required to run this suite");

class Rollback extends Error {}

function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("chat send conflict target — real partial index", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;
  let orgId: string;
  let channelId: number;

  beforeAll(async () => {
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client);
    const [row] = await db
      .select({ orgId: chatChannels.orgId, id: chatChannels.id })
      .from(chatChannels)
      .limit(1);
    if (!row) throw new Error("this suite needs a database with at least one chat_channels row");
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
