/**
 * `api_keys.key_prefix` carries a DEPLOYMENT-GLOBAL unique index, so the prefix
 * must carry enough entropy that two organisations never mint the same one.
 *
 * WHAT WAS WRONG. `generateApiKey()` built
 *
 *   rawKey    = "streamlineos_" + 64 hex characters
 *   keyPrefix = rawKey.slice(0, 16)
 *
 * "streamlineos_" is 13 characters, so the prefix carried exactly THREE hex
 * characters — 4,096 distinct values for the whole deployment. Measured, not
 * argued: 200,000 draws of the old expression produced 4,096 distinct prefixes,
 * and one birthday trial hit its first duplicate at the 73rd key.
 *
 * `idx_api_keys_key_prefix` is `CREATE UNIQUE INDEX ... ON api_keys (key_prefix)`
 * with no org_id, and `SettingsService.createApiKey` has no onConflict and no
 * retry, so the collision surfaces as an unhandled 23505: organisation B's admin
 * presses "create API key", lands on a prefix organisation A already holds, and
 * POST /settings/api-keys returns 500. Nothing in the message tells either party
 * why, and the same admin retrying draws from the same 4,096 buckets.
 *
 * THE FIX is entropy in the prefix, not a scoped index and not a retry.
 *
 *   - Scoping the index to (org_id, key_prefix) would let two organisations hold
 *     the same prefix. The prefix is what a human uses to tell one key from
 *     another in a support conversation, and it is shown in the UI
 *     (org-tokens-tab.tsx renders `{t.keyPrefix}…`). Weakening a live uniqueness
 *     invariant to work around a keyspace this fix removes is the wrong trade.
 *   - A 23505 retry treats the symptom. At 48 bits the collision probability is
 *     ~N/2.8e14 per insert — below the rate at which the `id` UUIDs in the same
 *     row collide — so a retry branch would be unreachable in production and
 *     reachable only from a test double. Dead code that looks like safety.
 *
 * Existing rows are unaffected: their prefixes are 16 characters and the new ones
 * are 25, so a new key cannot collide with an old one at all.
 *
 * SECURITY. key_prefix is stored in plaintext and IS a literal prefix of the
 * secret, so widening it hands out more of the raw key. rawKey carries 256 bits
 * of randomness; revealing 48 of them leaves 208, and authentication is by
 * sha256(rawKey) (api-key.guard.ts:42), never by prefix. The prefix is an
 * identifier, not a credential.
 *
 * The database half proves the index really is global, which is the reason the
 * entropy is load-bearing:
 *
 *   API_KEY_PROBE_DATABASE_URL=postgresql://… \
 *     node ./node_modules/jest/bin/jest.js --config ./jest-db.json --runInBand --testPathPattern="api-key-prefix-entropy"
 */
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { apiKeys, organizations, users } from "../../db/schema";
import { getPostgresErrorDetails } from "../../common/db/postgres-error";

const DB_URL = process.env.API_KEY_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
if (!DB_URL)
  throw new Error(
    "api-key-prefix-entropy.db.spec.ts requires API_KEY_PROBE_DATABASE_URL or APP_DATABASE_URL",
  );

describe("api key prefix entropy — real catalog", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    client = postgres(DB_URL as string, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("idx_api_keys_key_prefix is unique and carries NO org_id — a collision crosses tenants", async () => {
    const columns = await client<Array<{ col: string }>>`
      SELECT a.attname AS col
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
       WHERE i.relname = 'idx_api_keys_key_prefix'
         AND x.indisunique
       ORDER BY a.attname`;

    expect(columns.map((row) => row.col)).toEqual(["key_prefix"]);
  });

  it("two organisations cannot hold the same prefix — 23505 on that index", async () => {
    const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
    const [user] = await db.select({ id: users.id }).from(users).limit(1);
    if (!org || !user) throw new Error("api-key-prefix-entropy.db.spec.ts needs a database with an organization and a user");

    const collidingPrefix = `streamlineos_dup_${randomUUID().slice(0, 8)}`;
    const row = (name: string) => ({
      id: randomUUID(),
      orgId: org.id,
      name,
      keyHash: createHash("sha256").update(name).digest("hex"),
      keyPrefix: collidingPrefix,
      scopes: [],
      createdBy: user.id,
    });

    await client.unsafe("BEGIN");
    const observed = await (async () => {
      try {
        await db.insert(apiKeys).values(row("first"));
        await db.insert(apiKeys).values(row("second"));
        return { code: undefined, constraint: undefined };
      } catch (error) {
        const details = getPostgresErrorDetails(error);
        return { code: details.code, constraint: details.constraint };
      } finally {
        await client.unsafe("ROLLBACK");
      }
    })();

    expect(observed).toEqual({ code: "23505", constraint: "idx_api_keys_key_prefix" });
  });

  it("leaves nothing behind", async () => {
    const rows = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(eq(apiKeys.name, "first"));
    expect(rows.length).toBe(0);
  });
});
