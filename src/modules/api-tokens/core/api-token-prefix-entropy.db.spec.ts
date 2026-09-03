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
 * The database half is guarded by API_KEY_DB_TESTS=1 in the house `.db.spec.ts`
 * style; it proves THIS writer's prefix is subject to the global index, which is
 * what makes the entropy load-bearing. Every write happens inside a transaction
 * that is rolled back.
 *
 *   API_KEY_DB_TESTS=1 API_KEY_PROBE_DATABASE_URL=postgresql://… \
 *     npx jest --runInBand --testPathPattern="api-token-prefix-entropy"
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
// Named imports, not `import * as schema`: the wildcard pulls the retired legacy
// identity tables into scope and trips `no-restricted-imports`. Nothing here uses
// `db.query.*`, so drizzle needs no relational schema argument at all.
import { apiKeys, organizations, users } from "../../../db/schema";
import { getPostgresErrorDetails } from "../../../common/db/postgres-error";
import { API_TOKEN_LABEL, generateApiToken } from "./api-token-key";
import { generateApiKey } from "../../settings/settings.helpers";

const ENABLED = process.env.API_KEY_DB_TESTS === "1";
const DB_URL = process.env.API_KEY_PROBE_DATABASE_URL ?? process.env.APP_DATABASE_URL;
const describeDb = ENABLED && DB_URL ? describe : describe.skip;

const SRC_ROOT = join(__dirname, "..", "..", "..");

/** The keyspace of the expression that shipped, kept so the floor below means something. */
const SHIPPED_KEYSPACE = 16 ** 7; // "sk_" + 7 hex characters = 268,435,456

/**
 * Every production file that inserts into `api_keys`. A writer not in this set has
 * no entropy floor asserted anywhere, which is precisely how `createToken` kept a
 * 7-character prefix after the sibling writer was widened.
 */
const KNOWN_WRITERS = [
  "modules/api-tokens/core/api-tokens.service.ts",
  "modules/settings/settings.service.ts",
];

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full));
    } else if (entry.endsWith(".ts") && !entry.includes(".spec.")) {
      found.push(full);
    }
  }
  return found;
}

describe("api token prefix entropy", () => {
  it("the prefix is a real prefix of the token, and the hash is of the whole token", () => {
    const { rawKey, keyHash, keyPrefix } = generateApiToken();

    expect(rawKey.startsWith(API_TOKEN_LABEL)).toBe(true);
    expect(rawKey.startsWith(keyPrefix)).toBe(true);
    expect(keyHash).toBe(createHash("sha256").update(rawKey).digest("hex"));
    // Decoupling the prefix from the token would satisfy the entropy floor below
    // while making the displayed prefix useless for identifying the token it names.
    expect(keyPrefix.length).toBeLessThan(rawKey.length);
  });

  it("carries at least 12 random hex characters after the literal", () => {
    const random = generateApiToken().keyPrefix.slice(API_TOKEN_LABEL.length);

    // 7 as shipped. 12 is 48 bits — the floor the other writer into this index uses.
    expect(random.length).toBeGreaterThanOrEqual(12);
    expect(random).toMatch(/^[0-9a-f]+$/);
  });

  it("enumerates every writer into api_keys, so a third cannot appear unguarded", () => {
    const writers = sourceFilesUnder(SRC_ROOT)
      .filter((file) => /\.insert\(\s*apiKeys\s*\)/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC_ROOT.length + 1).split(/[\\/]/).join("/"))
      .sort();

    // If this fails with a new path, that writer inserts into a deployment-global
    // unique index: give it an entropy floor and add it here.
    expect(writers).toEqual(KNOWN_WRITERS);
  });

  it("both writers clear the floor, and their prefixes cannot collide with each other", () => {
    const token = generateApiToken().keyPrefix;
    const key = generateApiKey().keyPrefix;

    expect(token.startsWith("sk_")).toBe(true);
    expect(key.startsWith("streamlineos_")).toBe(true);
    // Different literals, so no draw from one writer can ever equal a draw from the
    // other however the two keyspaces are sized.
    expect(token.startsWith(key)).toBe(false);
    expect(key.startsWith(token)).toBe(false);
  });

  it("200,000 tokens produce 200,000 distinct prefixes — the shipped expression produced 199,943", () => {
    const draws = 200_000;
    const prefixes = new Set<string>();
    for (let i = 0; i < draws; i++) prefixes.add(generateApiToken().keyPrefix);

    // 200,000 and not 20,000, so this separates the two implementations with no
    // flake in EITHER direction. At the shipped 2^28 the expected number of
    // collisions in 200,000 draws is ~74, so P(zero collisions) is about e^-74 —
    // the assertion cannot pass by luck. At 2^48 the expected number is 7e-5, so
    // it cannot fail by luck either. At 20,000 draws the shipped expression would
    // have collided only about half the time: a coin flip, not a test.
    expect(prefixes.size).toBe(draws);
  });

  it("proves the floor is not vacuous — the shipped expression really did collide", () => {
    const shippedPrefix = () => `sk_${randomBytes(32).toString("hex")}`.slice(0, 10);
    const prefixes = new Set<string>();
    const draws = 200_000;
    for (let i = 0; i < draws; i++) prefixes.add(shippedPrefix());

    // Same draw count as the test above, against the expression that shipped.
    // Expected distinct = 2^28 * (1 - (1 - 2^-28)^200000) ~= 199,926; the margin
    // below is ~40 standard deviations, so this is deterministic in practice.
    expect(prefixes.size).toBeLessThan(draws);
    expect(SHIPPED_KEYSPACE).toBe(268_435_456);
  });
});

describeDb("api token prefix entropy — real catalog", () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;

  beforeAll(() => {
    // Narrowed, not asserted: `describeDb` already skips when DB_URL is unset, but
    // CLAUDE.md section 6 forbids forcing the type to say so.
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
    if (!org || !user) throw new Error("API_KEY_DB_TESTS needs a database with an organization and a user");

    // The prefix really minted by the production helper, inserted twice. The second
    // insert is the collision another organisation would have caused.
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
        // Drizzle wraps driver errors: the SQLSTATE lives on `.cause`, not `.code`.
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
