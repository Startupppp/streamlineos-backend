/**
 * `api_keys.key_prefix` carries ONE deployment-global unique index and TWO writers.
 * This spec covers the second one, and asserts there is no third.
 *
 * WHAT WAS WRONG. The release audit found `SettingsService.createApiKey` minting a
 * 3-hex-character prefix into `idx_api_keys_key_prefix` — `(key_prefix)`, no
 * `org_id` — and that was fixed in `settings.helpers.ts` (12 hex characters, and
 * `api-key-prefix-entropy.db.spec.ts` guards it). It is not the only writer.
 * `ApiTokensService.createToken` inserts into the SAME table, under the SAME
 * global unique index, and built its prefix inline:
 *
 *   const rawKey    = `sk_${randomBytes(32).toString("hex")}`;
 *   const keyPrefix = rawKey.slice(0, 10);
 *
 * "sk_" is 3 characters, so that left SEVEN hex characters — 16^7 = 268,435,456
 * values for the whole deployment. Measured, not argued: 200,000 draws of that
 * expression produced 199,943 distinct prefixes (57 collisions), and a birthday
 * trial hit its first duplicate at token 40,966. `createToken` has no
 * `onConflict` and no retry, so a collision is an unhandled 23505 and a 500 on
 * `POST /api-tokens` for whichever organisation drew second — a live route
 * (app.module.ts:190, `/api-tokens` in openapi.json), and the collision crosses
 * tenants because the index does.
 *
 * WHY IT SURVIVED THE FIRST FIX. The generation was inline in a service method
 * that also writes the database and dispatches a notification, so there was no
 * seam to assert an invariant against and nothing pointed from one writer to the
 * other. It is extracted to `api-token-key.ts` here for exactly that reason, and
 * the third test below is the anti-vacuity guard: it enumerates every production
 * `insert(apiKeys)` call site and fails if a writer appears that this spec does
 * not know about. That test is the one that would have caught this gap.
 *
 * WHY ENTROPY AND NOT A SCOPED INDEX OR A RETRY. Same reasoning as the sibling
 * writer: scoping the index to `(org_id, key_prefix)` would weaken a live
 * uniqueness invariant and let two organisations show the same prefix in the UI,
 * and at 48 bits a retry branch is unreachable in production — dead code that
 * looks like safety.
 *
 * The hermetic half lives in `api-token-prefix-entropy.spec.ts` and runs in the
 * default suite. This file proves THIS writer's prefix is subject to the global
 * index, which is what makes the entropy load-bearing. Every write happens inside
 * a transaction that is rolled back.
 *
 *   API_KEY_PROBE_DATABASE_URL=postgresql://… \
 *     npx jest --config jest-db.json --runInBand --testPathPattern="api-token-prefix-entropy"
 */
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
// Named imports, not `import * as schema`: the wildcard pulls the retired legacy
// identity tables into scope and trips `no-restricted-imports`. Nothing here uses
// `db.query.*`, so drizzle needs no relational schema argument at all.
import { apiKeys, organizations, users } from "../../../db/schema";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
import { generateApiToken } from "./api-token-key";

const DB_URL = process.env.API_KEY_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;

describe("api token prefix entropy — real catalog", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    if (!DB_URL) throw new Error("API_KEY_PROBE_DATABASE_URL or APP_DATABASE_URL must be set");
    client = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
    db = drizzle(client);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it("a token prefix is subject to idx_api_keys_key_prefix, which carries no org_id", async () => {
    const [org] = await db.select({ id: organizations.id }).from(organizations).limit(1);
    const [user] = await db.select({ id: users.id }).from(users).limit(1);
    if (!org || !user) throw new Error("API_KEY_PROBE_DATABASE_URL needs a database with at least one organization and one user");

    const minted = generateApiToken().keyPrefix;
    const row = (name: string) => ({
      id: randomUUID(),
      orgId: org.id,
      name,
      keyHash: createHash("sha256").update(name + minted).digest("hex"),
      keyPrefix: minted,
      scopes: ["leads:write"],
      createdBy: user.id,
    });

    await client.unsafe("BEGIN");
    const observed = await (async () => {
      try {
        await db.insert(apiKeys).values(row("api-token-entropy-probe-first"));
        await db.insert(apiKeys).values(row("api-token-entropy-probe-second"));
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
      .where(eq(apiKeys.name, "api-token-entropy-probe-first"));
    expect(rows.length).toBe(0);
  });
});
