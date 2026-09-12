import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AuthEmailVerificationService } from "./auth-email-verification.service";
import { hashToken } from "../../common/security/token.util";
import { generateToken } from "./auth-passwordless.utils";
import { magicLinkTokens, users, verificationTokens } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { EmailService } from "../email/email.service";

/**
 * The consume path is a conditional `DELETE … WHERE token = $1 AND expires >
 * now() RETURNING` inside one transaction. The double below models exactly that
 * — an atomic claim, a `findFirst` that yields at its await, and a transaction
 * that restores its snapshot on throw — so a read-then-act implementation loses
 * the race here for the same reason it loses it on a real server, which
 * `verify-auth-claim-races.mjs` measured on PostgreSQL 18.6.
 *
 * Predicates are rendered from the real Drizzle SQL, never matched by hand: an
 * unmodelled conjunct throws rather than passing silently, so dropping the
 * expiry from the claim cannot slip through as "no rows matched anyway".
 */

const IDENTIFIER = "verify@example.com";
const dialect = new PgDialect();

const VT_TOKEN = /^"verification_tokens"\."token" = (\$\d+)$/;
const VT_IDENTIFIER = /^"verification_tokens"\."identifier" = (\$\d+)$/;
const VT_UNEXPIRED = /^"verification_tokens"\."expires" > now\(\)$/;
const USER_BY_EMAIL = /^lower\("users"\."email"\) = (\$\d+)$/;

type VerificationRow = { identifier: string; token: string; expires: Date };

type UserRow = {
  id: string;
  email: string;
  isActive: boolean;
  deletedAt: Date | null;
  emailVerified: Date | null;
};

type StatementRecord = {
  operation: "claim" | "purge-identifier" | "stamp-verified" | "issue-login-token";
  kinds: string[];
  matched: number;
  inTransaction: boolean;
};

type World = {
  rows: VerificationRow[];
  userRows: UserRow[];
  magicLinkInserts: Array<Record<string, unknown>>;
  statements: StatementRecord[];
  magicLinkFailures: { remaining: number };
  afterTokenRead: { run: () => void };
  seed: (overrides?: Partial<VerificationRow>) => VerificationRow;
  db: Db;
};

function renderCondition(condition: unknown): { text: string; params: unknown[] } {
  if (!is(condition, SQL)) throw new Error("statement issued without a SQL condition");
  const query = dialect.sqlToQuery(condition);
  return { text: query.sql, params: query.params };
}

function conjunctsOf(text: string): string[] {
  const inner = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1) : text;
  return inner.split(" and ").map((part) => part.trim());
}

function paramValue(params: unknown[], token: string): unknown {
  return params[Number(token.slice(1)) - 1];
}

function kindOf(part: string): string {
  if (VT_TOKEN.test(part)) return "token";
  if (VT_IDENTIFIER.test(part)) return "identifier";
  if (VT_UNEXPIRED.test(part)) return "unexpired";
  throw new Error(`unmodelled predicate conjunct: ${part}`);
}

function conjunctHolds(part: string, row: VerificationRow, params: unknown[]): boolean {
  const byToken = VT_TOKEN.exec(part);
  if (byToken) return row.token === paramValue(params, byToken[1]);
  const byIdentifier = VT_IDENTIFIER.exec(part);
  if (byIdentifier) return row.identifier === paramValue(params, byIdentifier[1]);
  if (VT_UNEXPIRED.test(part)) return row.expires.getTime() > Date.now();
  throw new Error(`unmodelled predicate conjunct: ${part}`);
}

function makeResult(rows: unknown[]) {
  const settled = Promise.resolve(rows);
  return Object.assign(settled, { returning: () => settled });
}

/**
 * The one forced type in this file. A Drizzle `Db` is not constructible and the
 * frontend/backend assertion ledgers both exclude specs for exactly this reason;
 * it is confined to this factory so no test body carries one.
 */
function createWorld(userOverrides: Partial<UserRow> = {}): World {
  const rows: VerificationRow[] = [];
  const userRows: UserRow[] = [
    {
      id: "user-1",
      email: IDENTIFIER,
      isActive: true,
      deletedAt: null,
      emailVerified: null,
      ...userOverrides,
    },
  ];
  const magicLinkInserts: Array<Record<string, unknown>> = [];
  const statements: StatementRecord[] = [];
  const magicLinkFailures = { remaining: 0 };
  const afterTokenRead = { run: (): void => undefined };
  let depth = 0;

  function matchRows(condition: unknown) {
    const { text, params } = renderCondition(condition);
    const parts = conjunctsOf(text);
    const kinds = parts.map(kindOf);
    const matched = rows.filter((row) => parts.every((p) => conjunctHolds(p, row, params)));
    return { kinds, matched };
  }

  const remove = jest.fn((table: unknown) => ({
    where: (condition: unknown) => {
      if (table !== verificationTokens) throw new Error("unexpected delete target");
      const { kinds, matched } = matchRows(condition);
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      statements.push({
        operation: kinds.includes("token") ? "claim" : "purge-identifier",
        kinds,
        matched: matched.length,
        inTransaction: depth > 0,
      });
      return makeResult(matched.map((row) => ({ ...row })));
    },
  }));

  const update = jest.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (condition: unknown) => {
        if (table !== users) throw new Error("unexpected update target");
        const { text, params } = renderCondition(condition);
        const match = USER_BY_EMAIL.exec(text);
        if (!match) throw new Error(`unmodelled users predicate: ${text}`);
        const wanted = paramValue(params, match[1]);
        const stamp = values.emailVerified;
        if (!(stamp instanceof Date)) throw new Error("unmodelled users update");
        const matched = userRows.filter((row) => row.email === wanted);
        for (const row of matched) row.emailVerified = stamp;
        statements.push({
          operation: "stamp-verified",
          kinds: ["user-by-email"],
          matched: matched.length,
          inTransaction: depth > 0,
        });
        return makeResult([]);
      },
    }),
  }));

  const insert = jest.fn((table: unknown) => ({
    values: (value: Record<string, unknown>) => {
      if (table === magicLinkTokens) {
        statements.push({
          operation: "issue-login-token",
          kinds: [],
          matched: 1,
          inTransaction: depth > 0,
        });
        if (magicLinkFailures.remaining > 0) {
          magicLinkFailures.remaining -= 1;
          throw new Error("simulated login-token insert failure");
        }
        magicLinkInserts.push(value);
        return makeResult([]);
      }
      if (table !== verificationTokens) throw new Error("unexpected insert target");
      const expires = value.expires;
      rows.push({
        identifier: String(value.identifier),
        token: String(value.token),
        expires: expires instanceof Date ? expires : new Date(),
      });
      return makeResult([]);
    },
  }));

  const query = {
    users: {
      findFirst: jest.fn((config: { where?: unknown }) => {
        const { text, params } = renderCondition(config.where);
        const match = USER_BY_EMAIL.exec(text);
        if (!match) throw new Error(`unmodelled users predicate: ${text}`);
        const wanted = paramValue(params, match[1]);
        const found = userRows.find((row) => row.email === wanted);
        return Promise.resolve(found ? { ...found } : undefined);
      }),
    },
    verificationTokens: {
      findFirst: jest.fn((config: { where?: unknown }) => {
        const { matched } = matchRows(config.where);
        const found = matched[0];
        // The await boundary a read-then-act implementation suspends on, and the
        // window a second caller uses to read the same row.
        afterTokenRead.run();
        return Promise.resolve(found ? { ...found } : undefined);
      }),
    },
  };

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const rowSnapshot = rows.map((row) => ({ ...row }));
    const userSnapshot = userRows.map((row) => ({ target: row, state: { ...row } }));
    const magicLinkCount = magicLinkInserts.length;
    depth += 1;
    try {
      return await callback({ query, update, insert, delete: remove });
    } catch (error) {
      rows.splice(0, rows.length, ...rowSnapshot);
      for (const entry of userSnapshot) Object.assign(entry.target, entry.state);
      magicLinkInserts.splice(magicLinkCount, magicLinkInserts.length - magicLinkCount);
      throw error;
    } finally {
      depth -= 1;
    }
  });

  const seed = (overrides: Partial<VerificationRow> = {}): VerificationRow => {
    const row: VerificationRow = {
      identifier: IDENTIFIER,
      token: hashToken(generateToken()),
      expires: new Date(Date.now() + 3_600_000),
      ...overrides,
    };
    rows.push(row);
    return row;
  };

  const db = { query, update, insert, delete: remove, transaction } as unknown as Db;

  return {
    rows,
    userRows,
    magicLinkInserts,
    statements,
    magicLinkFailures,
    afterTokenRead,
    seed,
    db,
  };
}

function createEmail(options: { fails?: boolean } = {}) {
  const sendVerificationEmail = jest.fn((_address: string, _token: string) =>
    options.fails
      ? Promise.reject(new Error("transport unavailable"))
      : Promise.resolve(undefined),
  );
  return {
    sendVerificationEmail,
    service: { sendVerificationEmail } as unknown as EmailService,
  };
}

function makeService(world: World, email?: EmailService): AuthEmailVerificationService {
  return new AuthEmailVerificationService(world.db, email ?? createEmail().service);
}

function seedRawToken(world: World, overrides: Partial<VerificationRow> = {}): string {
  const raw = generateToken();
  world.seed({ token: hashToken(raw), ...overrides });
  return raw;
}

async function failureOf(promise: Promise<unknown>): Promise<BadRequestException> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return error as BadRequestException;
}

describe("verifyEmail — the claim is atomic and the consume is one transaction", () => {
  it("two concurrent verifications of one token: exactly one wins, exactly one login token is issued", async () => {
    const world = createWorld();
    const raw = seedRawToken(world);
    const svc = makeService(world);

    const [first, second] = await Promise.allSettled([
      svc.verifyEmail({ token: raw }),
      svc.verifyEmail({ token: raw }),
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as BadRequestException).getResponse(),
    ).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    expect(world.magicLinkInserts).toHaveLength(1);
    expect(world.rows).toHaveLength(0);
  });

  it("the claim predicate carries the token AND the expiry, so an expired row is never consumed", async () => {
    const world = createWorld();
    const raw = seedRawToken(world);
    await makeService(world).verifyEmail({ token: raw });

    const claims = world.statements.filter((s) => s.operation === "claim");
    expect(claims).toHaveLength(1);
    expect(claims[0].kinds.sort()).toEqual(["token", "unexpired"]);
  });

  it("an expired token is refused and issues nothing", async () => {
    const world = createWorld();
    const raw = seedRawToken(world, { expires: new Date(Date.now() - 1_000) });

    const error = await failureOf(makeService(world).verifyEmail({ token: raw }));

    expect(error.getResponse()).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    expect(world.magicLinkInserts).toHaveLength(0);
    expect(world.userRows[0].emailVerified).toBeNull();
    // The row is left alone: the claim matched nothing, it did not delete it.
    expect(world.rows).toHaveLength(1);
  });

  it("the claim, the verified stamp and the login-token insert all run inside one transaction", async () => {
    const world = createWorld();
    const raw = seedRawToken(world);

    await makeService(world).verifyEmail({ token: raw });

    expect(world.statements.map((s) => s.operation)).toEqual([
      "claim",
      "stamp-verified",
      "issue-login-token",
    ]);
    expect(world.statements.every((s) => s.inTransaction)).toBe(true);
  });

  it("a failure at the login-token insert restores the token, and the retry succeeds", async () => {
    const world = createWorld();
    const raw = seedRawToken(world);
    world.magicLinkFailures.remaining = 1;

    await expect(makeService(world).verifyEmail({ token: raw })).rejects.toThrow();
    expect(world.rows).toHaveLength(1);
    expect(world.userRows[0].emailVerified).toBeNull();
    expect(world.magicLinkInserts).toHaveLength(0);

    const retry = await makeService(world).verifyEmail({ token: raw });
    expect(typeof retry.autoLoginToken).toBe("string");
    expect(world.magicLinkInserts).toHaveLength(1);
    expect(world.rows).toHaveLength(0);
    expect(world.userRows[0].emailVerified).toBeInstanceOf(Date);
  });

  it("a replayed token is refused and issues nothing", async () => {
    const world = createWorld();
    const raw = seedRawToken(world);
    const svc = makeService(world);

    await svc.verifyEmail({ token: raw });
    const error = await failureOf(svc.verifyEmail({ token: raw }));

    expect(error.getResponse()).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    expect(world.magicLinkInserts).toHaveLength(1);
  });

  it.each([
    ["an inactive account", { isActive: false }],
    ["a soft-deleted account", { deletedAt: new Date("2024-01-01") }],
  ])("%s is refused, issues nothing, and does not burn the token", async (_label, overrides) => {
    const world = createWorld(overrides);
    const raw = seedRawToken(world);

    const error = await failureOf(makeService(world).verifyEmail({ token: raw }));

    expect(error.getResponse()).toMatchObject({ code: "AUTH_TOKEN_INVALID" });
    expect(world.magicLinkInserts).toHaveLength(0);
    expect(world.userRows[0].emailVerified).toBeNull();
    // The throw is inside the transaction, so the claim rolls back with it.
    expect(world.rows).toHaveLength(1);
  });

  it("verifying an older token leaves a token resent alongside it claimable", async () => {
    const world = createWorld();
    const oldRaw = seedRawToken(world);
    const newRaw = seedRawToken(world);

    await makeService(world).verifyEmail({ token: oldRaw });

    expect(world.rows).toHaveLength(1);
    expect(world.rows[0].token).toBe(hashToken(newRaw));
    const claims = world.statements.filter((s) => s.operation === "claim");
    expect(claims.every((s) => s.matched <= 1)).toBe(true);
  });

  it("the returned autoLoginToken is the raw secret whose digest was stored, and is never the input token", async () => {
    const world = createWorld();
    const raw = seedRawToken(world);

    const result = await makeService(world).verifyEmail({ token: raw });

    expect(world.magicLinkInserts).toHaveLength(1);
    expect(world.magicLinkInserts[0]).toMatchObject({
      userId: "user-1",
      tokenHash: hashToken(result.autoLoginToken),
    });
    expect(world.magicLinkInserts[0].tokenHash).not.toBe(result.autoLoginToken);
    expect(result.autoLoginToken).not.toBe(raw);
  });
});

describe("resendVerification — replacement, silence and transport failure", () => {
  it("purges every outstanding token for the identifier before inserting the replacement", async () => {
    const world = createWorld();
    seedRawToken(world);
    seedRawToken(world);
    const email = createEmail();

    await makeService(world, email.service).resendVerification(` ${IDENTIFIER.toUpperCase()} `);

    expect(world.statements.map((s) => s.operation)).toEqual(["purge-identifier"]);
    expect(world.statements[0].matched).toBe(2);
    expect(world.rows).toHaveLength(1);
    expect(email.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const [address, delivered] = email.sendVerificationEmail.mock.calls[0];
    expect(address).toBe(IDENTIFIER);
    expect(world.rows[0].token).toBe(hashToken(delivered));
  });

  it("(negative) an unknown address and an already-verified address are silent no-ops", async () => {
    const unknown = createWorld();
    const unknownEmail = createEmail();
    await expect(
      makeService(unknown, unknownEmail.service).resendVerification("nobody@example.com"),
    ).resolves.toBeUndefined();
    expect(unknownEmail.sendVerificationEmail).not.toHaveBeenCalled();
    expect(unknown.rows).toHaveLength(0);

    const verified = createWorld({ emailVerified: new Date("2026-01-01") });
    const verifiedEmail = createEmail();
    await expect(
      makeService(verified, verifiedEmail.service).resendVerification(IDENTIFIER),
    ).resolves.toBeUndefined();
    expect(verifiedEmail.sendVerificationEmail).not.toHaveBeenCalled();
    expect(verified.rows).toHaveLength(0);
  });

  it("a transport failure is reported as unavailable, and leaves the undelivered token claimable", async () => {
    // Pinned as current behaviour, not endorsed: magic-link and OTP both burn
    // the credential they could not deliver, this path does not. The row is
    // unguessable and single-use, so it is a divergence to decide, not a leak.
    const world = createWorld();
    const email = createEmail({ fails: true });

    await expect(
      makeService(world, email.service).resendVerification(IDENTIFIER),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(world.rows).toHaveLength(1);
    expect(world.statements.map((s) => s.operation)).toEqual(["purge-identifier"]);
  });

  it("CORRECT-BY-DESIGN: two parallel resends leave both delivered tokens claimable, each single-use", async () => {
    const world = createWorld();
    const email = createEmail();
    const svc = makeService(world, email.service);

    await Promise.all([
      svc.resendVerification(IDENTIFIER),
      svc.resendVerification(IDENTIFIER),
    ]);

    // Both were delivered to the same mailbox, so refusing the earlier one would
    // reject a link the person is holding. Each remains independently single-use.
    expect(world.rows).toHaveLength(2);
    const delivered = email.sendVerificationEmail.mock.calls.map((call) => call[1]);
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered).size).toBe(2);

    const consume = makeService(world, email.service);
    await consume.verifyEmail({ token: delivered[0] });
    await consume.verifyEmail({ token: delivered[1] });
    expect(world.rows).toHaveLength(0);
    expect(world.magicLinkInserts).toHaveLength(2);
    await failureOf(consume.verifyEmail({ token: delivered[0] }));
  });
});
