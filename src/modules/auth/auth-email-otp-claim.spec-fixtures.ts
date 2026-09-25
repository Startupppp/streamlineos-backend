/**
 * Harness for the email-OTP specs.
 *
 * An in-memory SQL evaluator standing in for Postgres: it renders each Drizzle
 * condition and applies it to plain row objects, so the assertions read real
 * predicates rather than a double's opinion of them.
 *
 * Extracted from `auth-email-otp-claim.spec.ts` so a second spec
 * (`auth-otp-outage-survivability.spec.ts`) can drive the same world. That file
 * was 831 lines, well past the 500-line limit; moving the harness out takes it
 * under, and nothing here changed in the move.
 */
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

export const BASE_MS = Date.now();
export const EMAIL = "  User@Example.COM  ";
export const NORMALIZED_EMAIL = "user@example.com";
export const CODE = "482931";
export const WRONG_CODE = "000000";
export const INVALID_MESSAGE = "Invalid or expired code";

export type OtpRow = {
  id: number;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
  createdAt: Date;
};

export type UserRow = {
  id: string;
  email: string;
  isActive: boolean;
  deletedAt: Date | null;
  emailVerified: Date | null;
};

export type StatementRecord = {
  operation: "bump" | "consume" | "invalidate";
  kinds: string[];
  text: string;
  matched: number;
  inTransaction: boolean;
};

export type SeedOptions = {
  code?: string;
  expiresInMs?: number;
  attempts?: number;
  ageMs?: number;
};

export type World = {
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
/**
 * HRMS-E2E-023. Once a send succeeds, `requestEmailOtp` retires the codes OLDER
 * than the one just delivered. Not "every code but mine": two resends racing
 * would then retire each other and leave the person with none.
 */
const OTP_OLDER = /^"email_otp_codes"\."id" < (\$\d+)$/;
const OTP_USER = /^"email_otp_codes"\."user_id" = (\$\d+)$/;
const OTP_UNUSED = /^"email_otp_codes"\."used_at" is null$/;
const OTP_UNEXPIRED = /^"email_otp_codes"\."expires_at" > now\(\)$/;
const OTP_STALE = /^"email_otp_codes"\."expires_at" < (\$\d+)$/;
const OTP_ATTEMPTS = /^"email_otp_codes"\."attempts" (<=|<) (\$\d+)$/;
const OTP_BUMP = /^"email_otp_codes"\."attempts" \+ (\d+)$/;
const USER_BY_EMAIL = /^lower\("users"\."email"\) = (\$\d+)$/;

export function renderCondition(condition: unknown): { text: string; params: unknown[] } {
  if (!is(condition, SQL)) throw new Error("statement issued without a SQL condition");
  const query = dialect.sqlToQuery(condition);
  return { text: query.sql, params: query.params };
}

export function conjunctsOf(text: string): string[] {
  const inner = text.startsWith("(") && text.endsWith(")") ? text.slice(1, -1) : text;
  return inner.split(" and ").map((part) => part.trim());
}

export function paramValue(params: unknown[], token: string): unknown {
  return params[Number(token.slice(1)) - 1];
}

export function timestampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

export function kindOf(part: string): string {
  if (OTP_ID.test(part)) return "id";
  if (OTP_OLDER.test(part)) return "older";
  if (OTP_USER.test(part)) return "user";
  if (OTP_UNUSED.test(part)) return "unused";
  if (OTP_UNEXPIRED.test(part)) return "unexpired";
  if (OTP_STALE.test(part)) return "stale";
  if (OTP_ATTEMPTS.test(part)) return "attempts";
  throw new Error(`unmodelled predicate conjunct: ${part}`);
}

export function conjunctHolds(
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
  const older = OTP_OLDER.exec(part);
  if (older) {
    const value = paramValue(params, older[1]);
    return typeof value === "number" && row.id < value;
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

export function makeResult(rows: unknown[]) {
  const settled = Promise.resolve(rows);
  return Object.assign(settled, { returning: () => settled });
}

export function createWorld(userOverrides: Partial<UserRow> = {}): World {
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

export function createEmail(options: { fails?: boolean } = {}) {
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

export function makeService(world: World, email?: EmailService): AuthEmailOtpService {
  return new AuthEmailOtpService(world.db, email ?? createEmail().service);
}

export async function failureOf(promise: Promise<unknown>): Promise<UnauthorizedException> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(UnauthorizedException);
  return error as UnauthorizedException;
}
