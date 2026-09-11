/**
 * public-token-controls.spec.ts
 *
 * Verification of public token security controls. No live database or network
 * needed: most of it reads source files as strings, and the agent-token
 * expiry/revocation block drives the real resolver against a database double
 * and inspects the SQL it produces.
 *
 * Verifies:
 *   1. hashToken is a bare unsalted SHA-256 (design fact; security note recorded).
 *   2. Agent token resolution filters revoked and expired tokens in the statement.
 *   3. Agent token cap enforced at TOKEN_CAP = 10.
 *   4. expiresAt column is nullable — non-expiring tokens are allowed.
 *   5. Every known @UseRateLimit key used on a @Public() route is in TIERS.
 *   6. SEC-004 regression: unknown tier key now denies.
 *
 * Suite: run with  node ./node_modules/jest/bin/jest.js test/security/public-token-controls.spec.ts
 *   Requires WIRING: "roots" in jest config must include "<rootDir>/test".
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  AGENT_TOKEN_PREFIX,
  resolveAgentToken,
} from "../../src/common/auth/agent-token-resolution";

const BACKEND_ROOT = join(__dirname, "../..");

function src(rel: string): string {
  return readFileSync(join(BACKEND_ROOT, rel), "utf8");
}

/**
 * Every `@UseRateLimit("…")` key this tree actually declares.
 *
 * Derived rather than listed, because the list this replaced could only ever go
 * stale in the direction it did. It named `sign:public-form-submit` — a key
 * belonging to a route that is not in this repository at all, since this
 * worktree's `e-sign` is a snapshot — so the assertion outlived the thing it
 * described and failed for a reason that had nothing to do with a rate limit
 * being wrong.
 *
 * The derived direction is also the one that matters. A key with no `TIERS`
 * entry does not error: `@UseRateLimit` on an unknown tier **silently disables
 * the limit**, so the dangerous state is a route that declares a key nothing
 * defines. Retiring a route AND its tier together is fine and this now ignores
 * it, as it should.
 */
function declaredRateLimitKeys(root: string): Set<string> {
  const keys = new Set<string>();
  const re = /@UseRateLimit\(\s*["']([^"']+)["']/g;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.includes(".spec.")) {
        const text = readFileSync(full, "utf8");
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) keys.add(m[1]);
        re.lastIndex = 0;
      }
    }
  };

  walk(root);
  return keys;
}

function parseTiersFromSource(rateLimitSrc: string): Set<string> {
  const tiers = new Set<string>();
  const blockMatch = rateLimitSrc.match(/const\s+TIERS\s*:\s*Record[^=]+=\s*\{([\s\S]*?)\n\}/);
  if (!blockMatch) return tiers;
  const block = blockMatch[1];
  const keyRe = /["']([^"']+)["']\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(block)) !== null) tiers.add(m[1]);
  return tiers;
}

describe("hashToken", () => {
  const tokenUtilSrc = src("src/common/security/token.util.ts");

  it("uses SHA-256", () => {
    expect(tokenUtilSrc).toMatch(/sha256/);
    expect(tokenUtilSrc).toMatch(/createHash/);
  });

  it("SECURITY NOTE — is bare unsalted hash (no salt or pepper)", () => {
    expect(tokenUtilSrc).not.toMatch(/randomBytes|salt|bcrypt|argon/i);
  });

  it("returns a hex digest", () => {
    expect(tokenUtilSrc).toMatch(/hex/);
  });
});

/**
 * Expiry and revocation, asked of the query rather than of the file.
 *
 * These two tests used to `readFileSync` the guard and grep it for `expiresAt`
 * and `revokedAt`. They went red the day the lookup was lifted out of
 * `AgentTokenGuard` into the shared `resolveAgentToken` — the controls had not
 * moved an inch, and the sweep could not tell the difference between a refactor
 * and a deletion. That cuts both ways: the grep would equally have passed on a
 * file that merely *mentions* `revokedAt` in a comment, or selects the column
 * without filtering on it. It never once looked at the WHERE clause.
 *
 * So this drives the real resolver against a database double, captures the
 * predicate it actually hands to `.where(...)`, and compiles it to SQL. What is
 * asserted is the text Postgres would receive: a revoked row and an expired row
 * are excluded by the statement itself, which is the only place they can be
 * excluded — the caller never sees the rows to check them.
 *
 * Testing the resolver rather than the guard is deliberate. It has two callers
 * now (`AgentTokenGuard` on `/agent/v1`, `JwtAuthGuard` on `@AllowAgentToken()`
 * routes), and one of them regressing while the other held would be invisible
 * to a per-guard test.
 */
describe("agent token resolution — expiry and revocation enforcement", () => {
  const VALID_TOKEN = `${AGENT_TOKEN_PREFIX}${"a".repeat(48)}`;

  /**
   * Runs the real resolver against a double that answers with no rows.
   *
   * No rows is the right answer to give it: `resolveAgentToken` returns null
   * the moment the lookup comes back empty, so it never reaches the membership
   * seam or `runInTenantTransaction`, and the double needs neither a tenant
   * context nor a membership fixture. The predicate is built on the way in
   * regardless, which is the whole of what is under test here.
   */
  async function predicateSql(): Promise<{ sql: string; params: unknown[] }> {
    let captured: SQL | undefined;
    const chain = {
      from: () => chain,
      where: (predicate: SQL) => {
        captured = predicate;
        return { limit: () => Promise.resolve([] as unknown[]) };
      },
    };
    const tx = { execute: () => Promise.resolve([]), select: () => chain };
    const db = {
      transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const membership = { resolve: () => Promise.resolve(null) };

    const resolved = await resolveAgentToken(
      db as never,
      membership as never,
      VALID_TOKEN,
    );
    // A token the statement did not return is a token the caller refuses.
    expect(resolved).toBeNull();
    expect(captured).toBeDefined();

    const query = new PgDialect().sqlToQuery(captured!);
    return { sql: query.sql, params: [...query.params] };
  }

  it("excludes revoked tokens in the statement, not in the caller", async () => {
    const { sql } = await predicateSql();
    expect(sql).toMatch(/"agent_tokens"\."revoked_at"\s+is\s+null/i);
  });

  it("excludes expired tokens, while still admitting non-expiring ones", async () => {
    const { sql, params } = await predicateSql();
    // Both halves matter: without the `is null` arm every non-expiring token
    // would be refused, and without the `>` arm expiry would not be enforced.
    expect(sql).toMatch(/"agent_tokens"\."expires_at"\s+is\s+null/i);
    expect(sql).toMatch(/"agent_tokens"\."expires_at"\s*>\s*\$\d/);
    // The comparison is against a bound instant, so it is evaluated at read
    // time rather than baked into a cached plan or a client-supplied value.
    expect(
      params.some((p) => typeof p === "string" && !Number.isNaN(Date.parse(p))),
    ).toBe(true);
  });

  it("keys the lookup on the hash of the presented credential", async () => {
    const { sql, params } = await predicateSql();
    expect(sql).toMatch(/"agent_tokens"\."token_hash"\s*=\s*\$\d/);
    expect(params).toContain(
      createHash("sha256").update(VALID_TOKEN).digest("hex"),
    );
    // ...and never on the credential itself.
    expect(params).not.toContain(VALID_TOKEN);
  });
});

describe("agent token schema — expiresAt nullable", () => {
  const schemaSrc = src("src/db/schema/common/agent-tokens.ts");

  it("expiresAt column is present", () => {
    expect(schemaSrc).toMatch(/expires_at|expiresAt/);
  });

  it("expiresAt is nullable (no .notNull() on it)", () => {
    const expiresAtLine = schemaSrc.split("\n").find((l) => l.includes("expires_at"));
    expect(expiresAtLine).toBeDefined();
    expect(expiresAtLine).not.toMatch(/\.notNull\(\)/);
  });
});

describe("agent token cap", () => {
  const serviceSrc = src("src/modules/agent-access/agent-tokens.service.ts");

  it("TOKEN_CAP is 10", () => {
    expect(serviceSrc).toMatch(/TOKEN_CAP\s*=\s*10/);
  });

  it("active token count is checked against TOKEN_CAP before creation", () => {
    expect(serviceSrc).toMatch(/active\s*>=\s*TOKEN_CAP/);
  });
});

describe("TIERS coverage for known @Public() @UseRateLimit keys", () => {
  const rateLimitSrc = src("src/common/ratelimit/rate-limit.service.ts");
  const tiers = parseTiersFromSource(rateLimitSrc);

  it("parsed at least 20 TIERS entries from rate-limit.service.ts", () => {
    expect(tiers.size).toBeGreaterThanOrEqual(20);
  });

  const declared = declaredRateLimitKeys(join(BACKEND_ROOT, "src"));

  /**
   * The floor is what stops this passing by finding nothing. A regex that stops
   * matching — a decorator rename, a move to a constant — would otherwise turn
   * the whole check green while covering zero routes, which is the exact failure
   * mode this file exists to prevent one layer down.
   */
  it("found the rate-limit declarations it is meant to be checking", () => {
    expect(declared.size).toBeGreaterThanOrEqual(20);
  });

  it("every declared @UseRateLimit key has a TIERS entry, or its limit is silently off", () => {
    const undefinedKeys = [...declared].filter((key) => !tiers.has(key)).sort();
    expect(undefinedKeys).toEqual([]);
  });
});

describe("SEC-004 regression — unknown tier key denies", () => {
  const rateLimitSrc = src("src/common/ratelimit/rate-limit.service.ts");

  it("rate-limit.service.ts returns allowed:false for unknown tier key", () => {
    expect(rateLimitSrc).toMatch(/allowed:\s*false/);
  });

  it("SEC-004 is referenced in the source (confirms the fix was intentional)", () => {
    expect(rateLimitSrc).toMatch(/SEC-004/);
  });
});
