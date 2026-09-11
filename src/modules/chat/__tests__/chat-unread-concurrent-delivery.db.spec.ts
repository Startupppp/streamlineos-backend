/**
 * Real-database proof that concurrent message delivery is atomic.
 *
 * The position allocator is `UPDATE chat_channels SET message_count = message_count + 1
 * RETURNING message_count`. Postgres places an exclusive row lock on the channel row during
 * that UPDATE; a concurrent sender's identical UPDATE blocks until the first commits. The
 * returned value is therefore strictly increasing across concurrent transactions, making
 * `channel_position` gapless and monotone in commit order.
 *
 * Two proofs here:
 *   BITE — without the exclusive UPDATE (replaced by a bare SELECT), two concurrent
 *          connections read the same counter value and insert two messages at the same
 *          `channel_position`. No unique constraint guards the column, so the duplicate
 *          silently lands. This is the exact class of bug the UPDATE lock prevents.
 *
 *   LOCK — with the production UPDATE-based allocation, the second connection blocks until
 *          the first commits. The returned counters are strictly sequential; the channel's
 *          `message_count` equals the number of committed messages; and `message_count -
 *          last_read_position` is therefore the exact unread count for any member.
 *
 * Every describe block opens its own scratch channel (committed so both connections can see
 * it) and rolls back or deletes in afterEach/afterAll so tests do not interfere.
 *
 *   CHAT_PROBE_DATABASE_URL=postgresql://neondb_owner@127.0.0.1:5432/scratch_local \
 *     ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     node ./node_modules/jest/bin/jest.js --config ./jest-db.json --runInBand \
 *       --testPathPattern="chat-unread-concurrent-delivery.db"
 *
 * This suite WRITES (channel and message fixtures). `jest-db-setup.ts` refuses the whole run
 * unless every *DATABASE_URL in the environment names a loopback host and the opt-in is set,
 * so it cannot reach the remote Neon database in `backend/.env`.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";

const DB_URL = requireApprovedDatabaseUrl({
  spec: "chat-unread-concurrent-delivery.db.spec.ts",
  vars: ["CHAT_PROBE_DATABASE_URL", "DATABASE_URL", "APP_DATABASE_URL"],
});

// The postgres.js row generic is a cast, so a wrong alias yields undefined; refuse rather than read 0.
function counterOf(row: { mc?: string } | undefined, what: string): number {
  const raw = row?.mc;
  if (raw === undefined || raw === null)
    throw new Error(`${what}: query returned no "mc" column; check the RETURNING/SELECT alias`);
  return Number(raw);
}

function sqlstateOf(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let hop = 0; hop < 6 && cursor !== null && cursor !== undefined; hop++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe("chat position allocation — the UPDATE row lock serialises concurrent sends", () => {
  let client1: postgres.Sql;
  let client2: postgres.Sql;
  let orgId: string;
  let channelId: number;

  beforeAll(async () => {
    client1 = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
    client2 = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });

    const [org] = await client1<Array<{ id: string }>>`SELECT id FROM organizations LIMIT 1`;
    if (!org) throw new Error("this suite needs a database with at least one organizations row");
    orgId = org.id;

    const channelName = `unread-concurrent-${randomUUID()}`;
    const [ch] = await client1<Array<{ id: number }>>`
      INSERT INTO chat_channels (org_id, name, type, is_private, is_archived)
      VALUES (${orgId}, ${channelName}, 'GROUP', true, false)
      RETURNING id`;
    if (!ch) throw new Error("test channel could not be created");
    channelId = ch.id;
  }, 60_000);

  afterEach(async () => {
    await client1.unsafe(`DELETE FROM chat_messages WHERE channel_id = $1`, [channelId]);
    await client1.unsafe(`UPDATE chat_channels SET message_count = 0 WHERE id = $1`, [channelId]);
  }, 60_000);

  afterAll(async () => {
    if (client1 && channelId) {
      await client1.unsafe(`DELETE FROM chat_messages WHERE channel_id = $1`, [channelId]);
      await client1.unsafe(`DELETE FROM chat_channels WHERE id = $1`, [channelId]);
    }
    await client1?.end({ timeout: 5 });
    await client2?.end({ timeout: 5 });
  }, 60_000);

  it("BITE: without the exclusive UPDATE, two concurrent readers see the same counter and produce a duplicate position", async () => {
    const [start] = await client1<Array<{ mc: string }>>`
      SELECT message_count AS mc FROM chat_channels WHERE id = ${channelId}`;
    const startCount = counterOf(start, "start counter");

    const insertViaBareSelect = async (client: postgres.Sql, label: string): Promise<number> => {
      await client.unsafe("BEGIN");
      const [row] = await client<Array<{ mc: string }>>`
        SELECT message_count AS mc FROM chat_channels WHERE id = ${channelId}`;
      const pos = counterOf(row, "bite read") + 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      await client.unsafe(
        `INSERT INTO chat_messages (org_id, channel_id, content, channel_position)
         VALUES ($1, $2, $3, $4)`,
        [orgId, channelId, label, pos],
      );
      await client.unsafe("COMMIT");
      return pos;
    };

    const [pos1, pos2] = await Promise.all([
      insertViaBareSelect(client1, "bite-msg-1"),
      insertViaBareSelect(client2, "bite-msg-2"),
    ]);

    expect(pos1).toBe(startCount + 1);
    expect(pos2).toBe(startCount + 1);

    const [{ dupes }] = await client1<Array<{ dupes: string }>>`
      SELECT count(*) AS dupes FROM chat_messages
       WHERE channel_id = ${channelId} AND channel_position = ${pos1}`;
    expect(Number(dupes)).toBe(2);
  });

  it("LOCK: two concurrent connections via UPDATE get distinct, gapless positions — the second blocks on the first's row lock", async () => {
    await client1.unsafe("BEGIN");
    const [p1Lock] = await client1<Array<{ mc: string }>>`
      UPDATE chat_channels SET message_count = message_count + 1
       WHERE id = ${channelId} RETURNING message_count AS mc`;
    const pos1 = counterOf(p1Lock, "conn1 allocation");

    const p2Promise = (async () => {
      await client2.unsafe("BEGIN");
      const [p2Lock] = await client2<Array<{ mc: string }>>`
        UPDATE chat_channels SET message_count = message_count + 1
         WHERE id = ${channelId} RETURNING message_count AS mc`;
      const pos2 = counterOf(p2Lock, "conn2 allocation");
      await client2.unsafe(
        `INSERT INTO chat_messages (org_id, channel_id, content, channel_position)
         VALUES ($1, $2, 'conn2-msg', $3)`,
        [orgId, channelId, pos2],
      );
      await client2.unsafe("COMMIT");
      return pos2;
    })();

    await new Promise((resolve) => setTimeout(resolve, 80));

    await client1.unsafe(
      `INSERT INTO chat_messages (org_id, channel_id, content, channel_position)
       VALUES ($1, $2, 'conn1-msg', $3)`,
      [orgId, channelId, pos1],
    );
    await client1.unsafe("COMMIT");

    const pos2 = await p2Promise;

    expect(pos1).toBe(1);
    expect(pos2).toBe(2);

    const [{ mc }] = await client1<Array<{ mc: string }>>`
      SELECT message_count AS mc FROM chat_channels WHERE id = ${channelId}`;
    expect(Number(mc)).toBe(2);
  });

  it("N concurrent sends via the UPDATE lock produce N distinct, gapless positions and message_count = N", async () => {
    const N = 4;
    const extraClients = Array.from({ length: N - 2 }, () =>
      postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined }),
    );
    const allClients = [client1, client2, ...extraClients];

    const sendWithLock = async (client: postgres.Sql, label: string): Promise<number> => {
      await client.unsafe("BEGIN");
      const [row] = await client<Array<{ mc: string }>>`
        UPDATE chat_channels SET message_count = message_count + 1
         WHERE id = ${channelId} RETURNING message_count AS mc`;
      const pos = counterOf(row, "position allocation");
      await client.unsafe(
        `INSERT INTO chat_messages (org_id, channel_id, content, channel_position)
         VALUES ($1, $2, $3, $4)`,
        [orgId, channelId, label, pos],
      );
      await client.unsafe("COMMIT");
      return pos;
    };

    const positions = await Promise.all(
      allClients.map((c, i) => sendWithLock(c, `concurrent-msg-${i}`)),
    ).finally(async () => {
      for (const c of extraClients) await c.end({ timeout: 5 });
    });

    const sorted = [...positions].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4]);

    const unique = new Set(positions);
    expect(unique.size).toBe(N);

    const [{ mc }] = await client1<Array<{ mc: string }>>`
      SELECT message_count AS mc FROM chat_channels WHERE id = ${channelId}`;
    expect(Number(mc)).toBe(N);
  });

  it("message_count minus last_read_position equals the number of messages above the cursor", async () => {
    const sendWithLock = async (label: string): Promise<void> => {
      await client1.unsafe("BEGIN");
      const [row] = await client1<Array<{ mc: string }>>`
        UPDATE chat_channels SET message_count = message_count + 1
         WHERE id = ${channelId} RETURNING message_count AS mc`;
      const pos = counterOf(row, "position allocation");
      await client1.unsafe(
        `INSERT INTO chat_messages (org_id, channel_id, content, channel_position)
         VALUES ($1, $2, $3, $4)`,
        [orgId, channelId, label, pos],
      );
      await client1.unsafe("COMMIT");
    };

    await sendWithLock("unread-1");
    await sendWithLock("unread-2");
    await sendWithLock("unread-3");

    const [{ mc }] = await client1<Array<{ mc: string }>>`
      SELECT message_count AS mc FROM chat_channels WHERE id = ${channelId}`;
    const messageCount = Number(mc);
    expect(messageCount).toBe(3);

    const lastReadPosition = 1;
    const expectedUnread = messageCount - lastReadPosition;
    expect(expectedUnread).toBe(2);

    const [{ actual }] = await client1<Array<{ actual: string }>>`
      SELECT count(*) AS actual FROM chat_messages
       WHERE channel_id = ${channelId} AND channel_position > ${lastReadPosition}`;
    expect(Number(actual)).toBe(expectedUnread);
  });

  it("a SAVEPOINT around a failing probe leaves the outer transaction intact — no 25P02 mask", async () => {
    await client1.unsafe("BEGIN");
    let caught: string | undefined;

    try {
      await client1.unsafe("SAVEPOINT fence");
      await client1.unsafe(
        `INSERT INTO chat_messages (org_id, channel_id, content, channel_position)
         VALUES ('_org_that_does_not_exist_', $1, 'should-fail', 1)`,
        [channelId],
      );
    } catch (err: unknown) {
      caught = sqlstateOf(err);
      await client1.unsafe("ROLLBACK TO SAVEPOINT fence");
    }

    const [{ mc }] = await client1<Array<{ mc: string }>>`
      SELECT message_count AS mc FROM chat_channels WHERE id = ${channelId}`;
    await client1.unsafe("ROLLBACK");

    expect(typeof caught).toBe("string");
    expect(Number(mc)).toBe(0);
  });
});
