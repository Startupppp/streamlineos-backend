import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AuthEmailOtpService } from "./auth-email-otp.service";
import { findOrCreateUser } from "./auth-passwordless.utils";
import { hashToken } from "../../common/security/token.util";
import { logger } from "../../common/logger/logger.service";
import { emailOtpCodes, magicLinkTokens, users } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import type { EmailService } from "../email/email.service";

const BASE_MS = Date.now();
const EMAIL = "  User@Example.COM  ";
const NORMALIZED_EMAIL = "user@example.com";
const CODE = "482931";
const WRONG_CODE = "000000";
const INVALID_MESSAGE = "Invalid or expired code";

type OtpRow = {
  id: number;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
  createdAt: Date;
};

type UserRow = {
  id: string;
  email: string;
  isActive: boolean;
  deletedAt: Date | null;
  emailVerified: Date | null;
};

type StatementRecord = {
  operation: "bump" | "consume" | "invalidate";
  kinds: string[];
  text: string;
  matched: number;
  inTransaction: boolean;
};

type SeedOptions = {
  code?: string;
  expiresInMs?: number;
  attempts?: number;
  ageMs?: number;
};

type World = {
  clock: { nowMs: number };
  rows: OtpRow[];
  userRows: UserRow[];
  magicLinkInserts: Array<Record<string, unknown>>;
  statements: StatementRecord[];
  operations: string[];
  magicLinkFailures: { remaining: number };
  afterOtpRead: { run: () => void };
  afterAttemptBump: { run: () => void };
  seed: (options?: SeedOptions) => OtpRow;
  db: Db;
};

const dialect = new PgDialect();

const OTP_ID = /^"email_otp_codes"\."id" = (\$\d+)$/;
const OTP_USER = /^"email_otp_codes"\."user_id" = (\$\d+)$/;
const OTP_UNUSED = /^"email_otp_codes"\."used_at" is null$/;
const OTP_UNEXPIRED = /^"email_otp_codes"\."expires_at" > now\(\)$/;
const OTP_STALE = /^"email_otp_codes"\."expires_at" < (\$\d+)$/;
const OTP_ATTEMPTS = /^"email_otp_codes"\."attempts" (<=|<) (\$\d+)$/;
const OTP_BUMP = /^"email_otp_codes"\."attempts" \+ (\d+)$/;
const USER_BY_EMAIL = /^lower\("users"\."email"\) = (\$\d+)$/;

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

function timestampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function kindOf(part: string): string {
  if (OTP_ID.test(part)) return "id";
  if (OTP_USER.test(part)) return "user";
  if (OTP_UNUSED.test(part)) return "unused";
  if (OTP_UNEXPIRED.test(part)) return "unexpired";
  if (OTP_STALE.test(part)) return "stale";
  if (OTP_ATTEMPTS.test(part)) return "attempts";
  throw new Error(`unmodelled predicate conjunct: ${part}`);
}

function conjunctHolds(
  part: string,
  row: OtpRow,
  params: unknown[],
  nowMs: number,
): boolean {
  const byId = OTP_ID.exec(part);
  if (byId) {
    const value = paramValue(params, byId[1]);
    return typeof value === "number" && row.id === value;
  }
  const byUser = OTP_USER.exec(part);
  if (byUser) {
    const value = paramValue(params, byUser[1]);
    return typeof value === "string" && row.userId === value;
  }
  if (OTP_UNUSED.test(part)) return row.usedAt === null;
  if (OTP_UNEXPIRED.test(part)) return row.expiresAt.getTime() > nowMs;
  const stale = OTP_STALE.exec(part);
  if (stale) {
    const ms = timestampMs(paramValue(params, stale[1]));
    return Number.isFinite(ms) && row.expiresAt.getTime() < ms;
  }
  const attempts = OTP_ATTEMPTS.exec(part);
  if (attempts) {
    const value = paramValue(params, attempts[2]);
    const limit = typeof value === "number" ? value : Number.NaN;
    return attempts[1] === "<=" ? row.attempts <= limit : row.attempts < limit;
  }
  throw new Error(`unmodelled predicate conjunct: ${part}`);
}

function makeResult(rows: unknown[]) {
  const settled = Promise.resolve(rows);
  return Object.assign(settled, { returning: () => settled });
}

function createWorld(userOverrides: Partial<UserRow> = {}): World {
  const clock = { nowMs: BASE_MS };
  const rows: OtpRow[] = [];
  const userRows: UserRow[] = [
    {
      id: "user-1",
      email: NORMALIZED_EMAIL,
      isActive: true,
      deletedAt: null,
      emailVerified: null,
      ...userOverrides,
    },
  ];
  const magicLinkInserts: Array<Record<string, unknown>> = [];
  const statements: StatementRecord[] = [];
  const operations: string[] = [];
  const magicLinkFailures = { remaining: 0 };
  const afterOtpRead = { run: (): void => undefined };
  const afterAttemptBump = { run: (): void => undefined };
  let nextId = 1;
  let depth = 0;

  function matchOtpRows(condition: unknown) {
    const { text, params } = renderCondition(condition);
    const parts = conjunctsOf(text);
    const kinds = parts.map(kindOf);
    const matched = rows.filter((row) =>
      parts.every((part) => conjunctHolds(part, row, params, clock.nowMs)),
    );
    return { text, kinds, matched };
  }

  function applyOtpSet(row: OtpRow, values: Record<string, unknown>): "bump" | "consume" {
    if ("attempts" in values) {
      const increment = values.attempts;
      if (!is(increment, SQL))
        throw new Error("the attempts counter must be bumped with a SQL expression");
      const bump = OTP_BUMP.exec(dialect.sqlToQuery(increment).sql);
      if (!bump) throw new Error("unmodelled attempts expression");
      row.attempts += Number(bump[1]);
      return "bump";
    }
    const usedAt = values.usedAt;
    if (!(usedAt instanceof Date)) throw new Error("unmodelled email_otp_codes update");
    row.usedAt = usedAt;
    return "consume";
  }

  function classify(values: Record<string, unknown>, kinds: string[]): StatementRecord["operation"] {
    if ("attempts" in values) return "bump";
    return kinds.includes("user") ? "invalidate" : "consume";
  }

  const update = jest.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (condition: unknown) => {
        if (table === users) {
          renderCondition(condition);
          const emailVerified = values.emailVerified;
          if (emailVerified instanceof Date)
            for (const row of userRows)
              if (row.emailVerified === null) row.emailVerified = emailVerified;
          operations.push("verify-user");
          return makeResult([]);
        }
        if (table !== emailOtpCodes) throw new Error("unexpected update target");

        const { text, kinds, matched } = matchOtpRows(condition);
        const operation = classify(values, kinds);
        statements.push({
          operation,
          kinds,
          text,
          matched: matched.length,
          inTransaction: depth > 0,
        });
        const returned = matched.map((row) => {
          applyOtpSet(row, values);
          return { ...row };
        });
        operations.push(operation);
        if (operation === "bump") afterAttemptBump.run();
        return makeResult(returned);
      },
    }),
  }));

  const insert = jest.fn((table: unknown) => ({
    values: (value: Record<string, unknown>) => {
      if (table === magicLinkTokens) {
        operations.push("insert-magic-link");
        if (magicLinkFailures.remaining > 0) {
          magicLinkFailures.remaining -= 1;
          return Promise.reject(new Error("simulated magic link insert failure"));
        }
        magicLinkInserts.push(value);
        return makeResult([]);
      }
      if (table !== emailOtpCodes) throw new Error("unexpected insert target");
      const expiresAt = value.expiresAt;
      const row: OtpRow = {
        id: nextId++,
        userId: String(value.userId),
        codeHash: String(value.codeHash),
        expiresAt: expiresAt instanceof Date ? expiresAt : new Date(clock.nowMs),
        usedAt: null,
        attempts: 0,
        createdAt: new Date(clock.nowMs),
      };
      rows.push(row);
      operations.push("insert-otp");
      return makeResult([{ id: row.id }]);
    },
  }));

  const remove = jest.fn((table: unknown) => ({
    where: (condition: unknown) => {
      if (table !== emailOtpCodes) throw new Error("unexpected delete target");
      const { matched } = matchOtpRows(condition);
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      operations.push("delete-stale");
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
    emailOtpCodes: {
      findFirst: jest.fn((config: { where?: unknown }) => {
        const { text, params } = renderCondition(config.where);
        const parts = conjunctsOf(text);
        const candidates = rows
          .filter((row) => parts.every((part) => conjunctHolds(part, row, params, clock.nowMs)))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
        const found = candidates[0];
        afterOtpRead.run();
        return Promise.resolve(found ? { ...found } : undefined);
      }),
    },
  };

  const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const rowSnapshot = rows.map((row) => ({ target: row, state: { ...row } }));
    const userSnapshot = userRows.map((row) => ({ target: row, state: { ...row } }));
    const magicLinkCount = magicLinkInserts.length;
    depth += 1;
    try {
      return await callback({ query, update, insert, delete: remove });
    } catch (error) {
      for (const entry of rowSnapshot) Object.assign(entry.target, entry.state);
      for (const entry of userSnapshot) Object.assign(entry.target, entry.state);
      rows.splice(0, rows.length, ...rowSnapshot.map((entry) => entry.target));
      userRows.splice(0, userRows.length, ...userSnapshot.map((entry) => entry.target));
      magicLinkInserts.splice(magicLinkCount, magicLinkInserts.length - magicLinkCount);
      throw error;
    } finally {
      depth -= 1;
    }
  });

  const seed = (options: SeedOptions = {}): OtpRow => {
    const row: OtpRow = {
      id: nextId++,
      userId: userRows[0].id,
      codeHash: hashToken(options.code ?? CODE),
      expiresAt: new Date(clock.nowMs + (options.expiresInMs ?? 600_000)),
      usedAt: null,
      attempts: options.attempts ?? 0,
      createdAt: new Date(clock.nowMs - (options.ageMs ?? 1_000)),
    };
    rows.push(row);
    return row;
  };

  const db = { query, update, insert, delete: remove, transaction } as unknown as Db;

  return {
    clock,
    rows,
    userRows,
    magicLinkInserts,
    statements,
    operations,
    magicLinkFailures,
    afterOtpRead,
    afterAttemptBump,
    seed,
    db,
  };
}

function createEmail(options: { fails?: boolean } = {}) {
  const sendEmailOtpEmail = jest.fn((_address: string, _code: string) =>
    options.fails
      ? Promise.reject(new Error("transport unavailable"))
      : Promise.resolve(undefined),
  );
  return {
    sendEmailOtpEmail,
    service: { sendEmailOtpEmail } as unknown as EmailService,
  };
}

function makeService(world: World, email?: EmailService): AuthEmailOtpService {
  return new AuthEmailOtpService(world.db, email ?? createEmail().service);
}

async function failureOf(promise: Promise<unknown>): Promise<UnauthorizedException> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthorizedException);
  return error as UnauthorizedException;
}

describe("verifyEmailOtp — the final claim must re-assert expiry", () => {
  it("a code that expires between the initial read and the claim cannot issue login material", async () => {
    const world = createWorld();
    const row = world.seed({ expiresInMs: 30_000 });
    world.afterOtpRead.run = () => {
      world.clock.nowMs += 60_000;
    };

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, CODE));

    expect(error.message).toBe(INVALID_MESSAGE);
    expect(error.getStatus()).toBe(401);
    expect(world.magicLinkInserts).toHaveLength(0);
    expect(row.usedAt).toBeNull();
  });

  it("the consume statement carries the expiry conjunct — removing it re-opens the case above", async () => {
    const world = createWorld();
    world.seed({ expiresInMs: 30_000 });
    world.afterOtpRead.run = () => {
      world.clock.nowMs += 60_000;
    };

    await failureOf(makeService(world).verifyEmailOtp(EMAIL, CODE));

    const consume = world.statements.find((statement) => statement.operation === "consume");
    expect(consume).toBeDefined();
    expect(consume?.kinds).toEqual(expect.arrayContaining(["id", "unused", "unexpired"]));
    expect(consume?.matched).toBe(0);
  });

  it("NEUTER: an unexpired code still verifies and issues exactly one login token", async () => {
    const world = createWorld();
    const row = world.seed();

    const result = await makeService(world).verifyEmailOtp(EMAIL, CODE);

    expect(typeof result.autoLoginToken).toBe("string");
    expect(result.autoLoginToken.length).toBeGreaterThan(0);
    expect(world.magicLinkInserts).toHaveLength(1);
    expect(world.magicLinkInserts[0]).toMatchObject({
      userId: "user-1",
      tokenHash: hashToken(result.autoLoginToken),
    });
    expect(row.usedAt).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(world.userRows[0].emailVerified).not.toBeNull();
  });
});

describe("verifyEmailOtp — the final claim must re-assert the attempt cap", () => {
  it("attempts exhausted by concurrent traffic between the bump and the claim cannot issue a token", async () => {
    const world = createWorld();
    const row = world.seed();
    world.afterAttemptBump.run = () => {
      row.attempts = 9;
      world.afterAttemptBump.run = () => undefined;
    };

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, CODE));

    expect(error.message).toBe(INVALID_MESSAGE);
    expect(world.magicLinkInserts).toHaveLength(0);
    expect(row.usedAt).toBeNull();

    const consume = world.statements.find((statement) => statement.operation === "consume");
    expect(consume?.kinds).toEqual(expect.arrayContaining(["attempts"]));
    expect(consume?.matched).toBe(0);
  });

  it("NEUTER: with no concurrent exhaustion the same code verifies", async () => {
    const world = createWorld();
    world.seed();

    const result = await makeService(world).verifyEmailOtp(EMAIL, CODE);

    expect(typeof result.autoLoginToken).toBe("string");
    expect(world.magicLinkInserts).toHaveLength(1);
  });

  it("first wrong attempt: refused, counter recorded, code left claimable", async () => {
    const world = createWorld();
    const row = world.seed();

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, WRONG_CODE));

    expect(error.message).toBe(INVALID_MESSAGE);
    expect(row.attempts).toBe(1);
    expect(row.usedAt).toBeNull();
    expect(world.magicLinkInserts).toHaveLength(0);
    expect(world.statements.filter((statement) => statement.operation === "consume")).toHaveLength(0);
  });

  it("fifth wrong attempt: refused at the hash check, counter reaches the cap", async () => {
    const world = createWorld();
    const row = world.seed({ attempts: 4 });

    await failureOf(makeService(world).verifyEmailOtp(EMAIL, WRONG_CODE));

    expect(row.attempts).toBe(5);
    expect(row.usedAt).toBeNull();
  });

  it("sixth attempt is refused even when the code is correct, and nothing is consumed", async () => {
    const world = createWorld();
    const row = world.seed({ attempts: 5 });

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, CODE));

    expect(error.message).toBe(INVALID_MESSAGE);
    expect(row.attempts).toBe(6);
    expect(row.usedAt).toBeNull();
    expect(world.magicLinkInserts).toHaveLength(0);
    expect(world.statements.filter((statement) => statement.operation === "consume")).toHaveLength(0);
  });
});

describe("verifyEmailOtp — two concurrent verifies of one code", () => {
  it("CORRECT-BY-DESIGN: exactly one wins the conditional claim", async () => {
    const world = createWorld();
    const row = world.seed();

    const settled = await Promise.allSettled([
      makeService(world).verifyEmailOtp(EMAIL, CODE),
      makeService(world).verifyEmailOtp(EMAIL, CODE),
    ]);

    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    expect(((rejected as PromiseRejectedResult).reason as Error).message).toBe(INVALID_MESSAGE);
    expect(world.magicLinkInserts).toHaveLength(1);
    expect(row.attempts).toBe(2);

    const consumes = world.statements.filter((statement) => statement.operation === "consume");
    expect(consumes).toHaveLength(2);
    expect(consumes.filter((statement) => statement.matched === 1)).toHaveLength(1);
    expect(consumes.filter((statement) => statement.matched === 0)).toHaveLength(1);
  });

  it("BITE: the double would admit the second claim if the predicate dropped used_at is null", () => {
    const consumed: OtpRow = {
      id: 7,
      userId: "user-1",
      codeHash: hashToken(CODE),
      expiresAt: new Date(BASE_MS + 600_000),
      usedAt: new Date(BASE_MS),
      attempts: 1,
      createdAt: new Date(BASE_MS),
    };

    expect(conjunctHolds('"email_otp_codes"."id" = $1', consumed, [7], BASE_MS)).toBe(true);
    expect(conjunctHolds('"email_otp_codes"."used_at" is null', consumed, [], BASE_MS)).toBe(false);
  });
});

describe("verifyEmailOtp — consuming the code and issuing login material are atomic", () => {
  it("a failure before the login-token insert must not burn the code", async () => {
    const world = createWorld();
    const row = world.seed();
    world.magicLinkFailures.remaining = 1;

    await expect(makeService(world).verifyEmailOtp(EMAIL, CODE)).rejects.toThrow(
      "simulated magic link insert failure",
    );

    expect(world.magicLinkInserts).toHaveLength(0);
    expect(row.usedAt).toBeNull();
    expect(world.userRows[0].emailVerified).toBeNull();
  });

  it("after that rollback the same code still verifies, and the attempt counter is NOT rolled back", async () => {
    const world = createWorld();
    const row = world.seed();
    world.magicLinkFailures.remaining = 1;

    await expect(makeService(world).verifyEmailOtp(EMAIL, CODE)).rejects.toThrow();
    expect(row.attempts).toBe(1);

    const result = await makeService(world).verifyEmailOtp(EMAIL, CODE);

    expect(typeof result.autoLoginToken).toBe("string");
    expect(world.magicLinkInserts).toHaveLength(1);
    expect(row.usedAt).not.toBeNull();
    expect(row.attempts).toBe(2);
  });

  it("the consume, the verified stamp and the token insert all run inside one transaction", async () => {
    const world = createWorld();
    world.seed();

    await makeService(world).verifyEmailOtp(EMAIL, CODE);

    const consume = world.statements.find((statement) => statement.operation === "consume");
    expect(consume?.inTransaction).toBe(true);
    const bump = world.statements.find((statement) => statement.operation === "bump");
    expect(bump?.inTransaction).toBe(false);
    expect(world.operations).toEqual(
      expect.arrayContaining(["bump", "consume", "verify-user", "insert-magic-link"]),
    );
  });
});

describe("verifyEmailOtp — identity state and enumeration resistance", () => {
  it("an inactive identity is refused before any counter is touched", async () => {
    const world = createWorld({ isActive: false });
    const row = world.seed();

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, CODE));

    expect(error.message).toBe(INVALID_MESSAGE);
    expect(row.attempts).toBe(0);
    expect(row.usedAt).toBeNull();
    expect(world.magicLinkInserts).toHaveLength(0);
  });

  it("a soft-deleted identity is refused before any counter is touched", async () => {
    const world = createWorld({ deletedAt: new Date(BASE_MS) });
    const row = world.seed();

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, CODE));

    expect(error.message).toBe(INVALID_MESSAGE);
    expect(row.attempts).toBe(0);
    expect(world.magicLinkInserts).toHaveLength(0);
  });

  it("the email is lowercased and trimmed before the identity lookup", async () => {
    const world = createWorld();
    world.seed();

    await makeService(world).verifyEmailOtp("\t USER@EXAMPLE.COM \n", CODE);

    const lookup = world.db.query.users.findFirst as unknown as jest.Mock;
    const rendered = renderCondition(lookup.mock.calls[0][0].where);
    expect(rendered.params).toEqual([NORMALIZED_EMAIL]);
  });

  it("every failure path answers with the same status and body", async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      () => {
        const world = createWorld();
        world.seed();
        return makeService(world).verifyEmailOtp("stranger@example.com", CODE);
      },
      () => makeService(createWorld()).verifyEmailOtp(EMAIL, CODE),
      () => {
        const world = createWorld({ isActive: false });
        world.seed();
        return makeService(world).verifyEmailOtp(EMAIL, CODE);
      },
      () => {
        const world = createWorld({ deletedAt: new Date(BASE_MS) });
        world.seed();
        return makeService(world).verifyEmailOtp(EMAIL, CODE);
      },
      () => {
        const world = createWorld();
        world.seed();
        return makeService(world).verifyEmailOtp(EMAIL, WRONG_CODE);
      },
      () => {
        const world = createWorld();
        world.seed({ attempts: 5 });
        return makeService(world).verifyEmailOtp(EMAIL, CODE);
      },
      () => {
        const world = createWorld();
        world.seed({ expiresInMs: 30_000 });
        world.afterOtpRead.run = () => {
          world.clock.nowMs += 60_000;
        };
        return makeService(world).verifyEmailOtp(EMAIL, CODE);
      },
      () => {
        const world = createWorld();
        const row = world.seed();
        world.afterAttemptBump.run = () => {
          row.attempts = 9;
          world.afterAttemptBump.run = () => undefined;
        };
        return makeService(world).verifyEmailOtp(EMAIL, CODE);
      },
    ];

    const answers: string[] = [];
    for (const scenario of scenarios) {
      const error = await failureOf(scenario());
      answers.push(JSON.stringify({ status: error.getStatus(), body: error.getResponse() }));
    }

    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain(INVALID_MESSAGE);
  });
});

describe("requestEmailOtp — resend invalidation, parallel resends and delivery inversion", () => {
  it("prior unused codes are invalidated before the replacement row is inserted", async () => {
    const world = createWorld();
    const prior = world.seed({ code: "111111" });
    const email = createEmail();

    await makeService(world, email.service).requestEmailOtp(EMAIL);

    expect(prior.usedAt).not.toBeNull();
    const invalidate = world.operations.indexOf("invalidate");
    const insert = world.operations.indexOf("insert-otp");
    expect(invalidate).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(invalidate);

    const statement = world.statements.find((entry) => entry.operation === "invalidate");
    expect(statement?.kinds).toEqual(expect.arrayContaining(["user", "unused"]));
  });

  it("after a resend the superseded code is refused and the replacement verifies", async () => {
    const world = createWorld();
    world.seed({ code: "111111" });
    const email = createEmail();
    const service = makeService(world, email.service);

    await service.requestEmailOtp(EMAIL);
    const issued = String(email.sendEmailOtpEmail.mock.calls[0][1]);

    const error = await failureOf(service.verifyEmailOtp(EMAIL, "111111"));
    expect(error.message).toBe(INVALID_MESSAGE);

    const result = await service.verifyEmailOtp(EMAIL, issued);
    expect(typeof result.autoLoginToken).toBe("string");
  });

  it("CORRECT-BY-DESIGN: with two live codes only the newest is accepted, never a superseded one", async () => {
    const world = createWorld();
    const older = world.seed({ code: "111111", ageMs: 5_000 });
    world.seed({ code: CODE, ageMs: 1_000 });

    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, "111111"));
    expect(error.message).toBe(INVALID_MESSAGE);
    expect(older.usedAt).toBeNull();

    const result = await makeService(world).verifyEmailOtp(EMAIL, CODE);
    expect(typeof result.autoLoginToken).toBe("string");
  });

  it("parallel resends leave no superseded code acceptable", async () => {
    const world = createWorld();
    const email = createEmail();
    const service = makeService(world, email.service);

    await Promise.all([service.requestEmailOtp(EMAIL), service.requestEmailOtp(EMAIL)]);

    const issued = email.sendEmailOtpEmail.mock.calls.map((call) => String(call[1]));
    expect(issued).toHaveLength(2);

    const newest = world.rows
      .filter((row) => row.usedAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)[0];
    expect(newest).toBeDefined();

    for (const code of issued) {
      const matchesNewest = newest.codeHash === hashToken(code);
      const outcome = await makeService(world)
        .verifyEmailOtp(EMAIL, code)
        .then(() => "accepted" as const)
        .catch(() => "refused" as const);
      expect(outcome).toBe(matchesNewest ? "accepted" : "refused");
      if (matchesNewest) break;
    }
  });

  it("a delivery failure burns the code it could not deliver and reports it as unavailable", async () => {
    const world = createWorld();
    const email = createEmail({ fails: true });
    const spy = jest.spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await expect(makeService(world, email.service).requestEmailOtp(EMAIL)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      spy.mockRestore();
    }

    expect(world.rows).toHaveLength(1);
    expect(world.rows[0].usedAt).not.toBeNull();

    const undelivered = String(email.sendEmailOtpEmail.mock.calls[0][1]);
    const error = await failureOf(makeService(world).verifyEmailOtp(EMAIL, undelivered));
    expect(error.message).toBe(INVALID_MESSAGE);
  });
});

function buildFindOrCreateDb(options: {
  firstLookup: { id: string; email: string } | null;
  insertReturns?: Array<{ id: string; email: string }>;
  fallbackLookup?: { id: string; email: string } | null;
  onInsert?: (values: Record<string, unknown>) => void;
}): Db {
  const findFirst = jest.fn();
  findFirst.mockResolvedValueOnce(options.firstLookup);
  if (options.fallbackLookup !== undefined) findFirst.mockResolvedValueOnce(options.fallbackLookup);

  return {
    query: { users: { findFirst } },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        if (options.onInsert) options.onInsert(values);
        return {
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(options.insertReturns ?? []),
          }),
        };
      }),
    }),
  } as unknown as Db;
}

describe("findOrCreateUser — identity creation contract", () => {
  it("normalizes mixed-case and surrounding whitespace before the lookup", async () => {
    const db = buildFindOrCreateDb({ firstLookup: { id: "u1", email: NORMALIZED_EMAIL } });

    const result = await findOrCreateUser(db, EMAIL);

    expect(result.email).toBe(NORMALIZED_EMAIL);
    expect(db.insert).not.toHaveBeenCalled();
    const lookup = db.query.users.findFirst as unknown as jest.Mock;
    expect(renderCondition(lookup.mock.calls[0][0].where).params).toEqual([NORMALIZED_EMAIL]);
  });

  it("persists the normalized address when it creates the identity", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = buildFindOrCreateDb({
      firstLookup: null,
      insertReturns: [{ id: "new-1", email: NORMALIZED_EMAIL }],
      onInsert: (values) => inserted.push(values),
    });

    const result = await findOrCreateUser(db, EMAIL);

    expect(result.id).toBe("new-1");
    expect(inserted[0]).toMatchObject({ email: NORMALIZED_EMAIL, isActive: true, emailVerified: null });
  });

  it("falls back to a re-read when the insert loses the unique-email race", async () => {
    const db = buildFindOrCreateDb({
      firstLookup: null,
      insertReturns: [],
      fallbackLookup: { id: "u-existing", email: "race@example.com" },
    });

    const result = await findOrCreateUser(db, "race@example.com");

    expect(result.id).toBe("u-existing");
  });

  it("reports the flow as unavailable when both the insert and the re-read return nothing", async () => {
    const db = buildFindOrCreateDb({ firstLookup: null, insertReturns: [], fallbackLookup: null });

    await expect(findOrCreateUser(db, "ghost@example.com")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
