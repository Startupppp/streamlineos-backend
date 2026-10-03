import { UnauthorizedException } from "@nestjs/common";
import { SQL, is } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AuthService } from "./auth.service";
import { readFileSync } from "fs";
import { join } from "path";
import { googleOAuthSchema } from "./dto/auth.schemas";

function hasWhere(value: unknown): value is { where: unknown } {
  return typeof value === "object" && value !== null && "where" in value;
}

type UserRow = { id: string; emailVerified: Date | null; isActive: boolean; deletedAt: Date | null };
type AccountRow = { userId: string };
type AccountUserRow = { isActive: boolean; deletedAt: Date | null };

interface DbOptions {
  existingGoogleAccount?: AccountRow | null;
  googleAccountUser?: AccountUserRow | null;
  existingEmailUser?: UserRow | null;
  txUserInsertResult?: Array<{ id: string }>;
  txRacedUser?: { id: string } | null;
}

function makeInsertChain(returning: unknown[]) {
  const chain = {
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(returning),
  };
  return chain;
}

function makeUpdateChain() {
  return {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDb(opts: DbOptions = {}) {
  const accountsFindFirst = jest.fn().mockResolvedValue(opts.existingGoogleAccount ?? null);
  const usersFindFirstMock = jest.fn();

  if (opts.existingGoogleAccount) {
    usersFindFirstMock.mockResolvedValueOnce(
      "googleAccountUser" in opts
        ? opts.googleAccountUser
        : { isActive: true, deletedAt: null },
    );
  } else {
    usersFindFirstMock.mockResolvedValueOnce(opts.existingEmailUser ?? null);
  }

  const txInsert = jest.fn().mockImplementation(() => ({
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(opts.txUserInsertResult ?? [{ id: "created-user-id" }]),
  }));

  const txQuery = {
    users: {
      findFirst: jest.fn().mockResolvedValue(opts.txRacedUser ?? null),
    },
  };

  const transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<string>) =>
    fn({ insert: txInsert, query: txQuery }),
  );

  const insert = jest.fn().mockImplementation(() => makeInsertChain([]));
  const update = jest.fn().mockReturnValue(makeUpdateChain());

  return {
    query: {
      accounts: { findFirst: accountsFindFirst },
      users: { findFirst: usersFindFirstMock },
    },
    insert,
    update,
    transaction,
    _txInsert: txInsert,
    _txQuery: txQuery,
    _accountsFindFirst: accountsFindFirst,
    _usersFindFirstMock: usersFindFirstMock,
  };
}

function makeService(db: ReturnType<typeof makeDb>) {
  const sessions = {} as never;
  const cache = {} as never;
  const audit = { log: jest.fn() };
  const entitlements = {} as never;
  const membershipResolver = {
    createLoginSession: jest.fn().mockResolvedValue("session-id-xyz"),
  };
  const analytics = {
    logLoginEvent: jest.fn(),
  };
  return new AuthService(
    db as never,
    sessions,
    cache,
    audit as never,
    entitlements,
    membershipResolver as never,
    analytics as never,
  );
}

const baseInput = { email: "user@example.com", googleId: "google-sub-123" };
const ctx = { userAgent: "test-ua", ipAddress: "127.0.0.1" };

describe("AuthService.googleOAuth — subject binding and trust boundary", () => {
  it("CORRECT-BY-DESIGN: providerAccountId lookup wins over email — wrong googleId never takes over an existing linked account", async () => {
    const db = makeDb({
      existingGoogleAccount: { userId: "user-a" },
      googleAccountUser: { isActive: true, deletedAt: null },
    });
    const svc = makeService(db);
    const result = await svc.googleOAuth(
      { email: "user-b@example.com", googleId: "google-sub-123" },
      ctx,
    );
    expect(result.userId).toBe("user-a");
    expect(db._accountsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ columns: { userId: true } }),
    );
  });

  it("CORRECT-BY-DESIGN: email trust boundary — Google-asserted email stamps emailVerified on an existing unverified user", async () => {
    const db = makeDb({
      existingEmailUser: { id: "user-unverified", emailVerified: null, isActive: true, deletedAt: null },
    });
    const svc = makeService(db);
    await svc.googleOAuth(baseInput, ctx);
    expect(db.update).toHaveBeenCalled();
  });

  it("CORRECT-BY-DESIGN: emailVerified is NOT re-stamped when already set", async () => {
    const db = makeDb({
      existingEmailUser: {
        id: "user-verified",
        emailVerified: new Date(),
        isActive: true,
        deletedAt: null,
      },
    });
    const svc = makeService(db);
    await svc.googleOAuth(baseInput, ctx);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("AuthService.googleOAuth — email normalisation (identity creation gap)", () => {
  function lookupParams(mock: jest.Mock): unknown[] {
    const callArg: unknown = mock.mock.calls[0]?.[0];
    if (!hasWhere(callArg) || !is(callArg.where, SQL))
      throw new Error("users.findFirst was not called with an SQL predicate");
    return new PgDialect().sqlToQuery(callArg.where).params;
  }

  it("normalises a mixed-case email before lookup", async () => {
    const db = makeDb({ existingEmailUser: { id: "u1", emailVerified: null, isActive: true, deletedAt: null } });
    const svc = makeService(db);
    await svc.googleOAuth({ email: "Person@EXAMPLE.COM", googleId: "g1" }, ctx);
    expect(lookupParams(db._usersFindFirstMock)).toContain("person@example.com");
    expect(lookupParams(db._usersFindFirstMock)).not.toContain("Person@EXAMPLE.COM");
  });

  it("trims whitespace from the email before lookup", async () => {
    const db = makeDb({ existingEmailUser: { id: "u2", emailVerified: null, isActive: true, deletedAt: null } });
    const svc = makeService(db);
    await svc.googleOAuth({ email: " user@example.com ", googleId: "g2" }, ctx);
    expect(lookupParams(db._usersFindFirstMock)).toContain("user@example.com");
    expect(lookupParams(db._usersFindFirstMock)).not.toContain(" user@example.com ");
  });

  it("cross-path simultaneity: OTP-created user races Google signup for same email — lands in existing-user branch", async () => {
    const db = makeDb({
      existingEmailUser: { id: "otp-created-user", emailVerified: null, isActive: true, deletedAt: null },
    });
    const svc = makeService(db);
    const result = await svc.googleOAuth(baseInput, ctx);
    expect(result.userId).toBe("otp-created-user");
    expect(result.isNewUser).toBe(false);
  });
});

describe("AuthService.googleOAuth — disabled and deleted account (all branches)", () => {
  it("denies when the linked Google account belongs to an inactive user", async () => {
    const db = makeDb({
      existingGoogleAccount: { userId: "user-inactive" },
      googleAccountUser: { isActive: false, deletedAt: null },
    });
    const svc = makeService(db);
    await expect(svc.googleOAuth(baseInput, ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("denies when the linked Google account belongs to a soft-deleted user", async () => {
    const db = makeDb({
      existingGoogleAccount: { userId: "user-deleted" },
      googleAccountUser: { isActive: true, deletedAt: new Date() },
    });
    const svc = makeService(db);
    await expect(svc.googleOAuth(baseInput, ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("denies when the linked Google account has no user row (safety net)", async () => {
    const db = makeDb({
      existingGoogleAccount: { userId: "user-ghost" },
      googleAccountUser: null,
    });
    const svc = makeService(db);
    await expect(svc.googleOAuth(baseInput, ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("denies when an existing email-matched user is inactive", async () => {
    const db = makeDb({
      existingEmailUser: { id: "user-inactive", emailVerified: null, isActive: false, deletedAt: null },
    });
    const svc = makeService(db);
    await expect(svc.googleOAuth(baseInput, ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("denies when an existing email-matched user is soft-deleted", async () => {
    const db = makeDb({
      existingEmailUser: {
        id: "user-deleted",
        emailVerified: null,
        isActive: true,
        deletedAt: new Date(),
      },
    });
    const svc = makeService(db);
    await expect(svc.googleOAuth(baseInput, ctx)).rejects.toThrow(UnauthorizedException);
  });
});

describe("AuthService.googleOAuth — duplicate callback (concurrent new-user create)", () => {
  it("REPRODUCED then FIXED: concurrent create for same email uses conflict-fallback to resolve to the winning row", async () => {
    const racedUserId = "raced-user-id";
    const db = makeDb({
      existingGoogleAccount: null,
      existingEmailUser: null,
      txUserInsertResult: [],
      txRacedUser: { id: racedUserId },
    });
    const svc = makeService(db);
    const result = await svc.googleOAuth(baseInput, ctx);
    expect(result.userId).toBe(racedUserId);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db._txQuery.users.findFirst).toHaveBeenCalled();
  });

  it("new-user transaction invokes its callback (callback is not voided by the mock)", async () => {
    const db = makeDb({
      existingGoogleAccount: null,
      existingEmailUser: null,
      txUserInsertResult: [{ id: "fresh-user-id" }],
    });
    const svc = makeService(db);
    const result = await svc.googleOAuth(baseInput, ctx);
    expect(result.userId).toBe("fresh-user-id");
    expect(db._txInsert).toHaveBeenCalled();
  });

  it("concurrent-race: the account insert in googleOAuth is onConflictDoNothing, so a racing sign-in cannot fail on the unique key", () => {
    const text = readFileSync(join(__dirname, "auth.service.ts"), "utf8");
    const at = text.indexOf("async googleOAuth(");
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at)).toMatch(/\.insert\(accounts\)[\s\S]{0,300}\.onConflictDoNothing\(\)/);
  });
});

describe("AuthService.googleOAuth — denied consent is NextAuth-side, wrong internal secret is controller-gate", () => {
  it("wrong internal secret → 403 before reaching AuthService: the controller checks the secret before it calls googleOAuth", () => {
    const text = readFileSync(join(__dirname, "auth.controller.ts"), "utf8");
    const handler = text.slice(text.indexOf("async googleOAuth("));
    const secretCheck = handler.indexOf("internalSecretMatches(");
    expect(secretCheck).toBeGreaterThan(-1);
    expect(handler.indexOf("HttpStatus.FORBIDDEN")).toBeGreaterThan(secretCheck);
    expect(handler.indexOf("this.authService.googleOAuth(")).toBeGreaterThan(handler.indexOf("HttpStatus.FORBIDDEN"));
  });

  it("denied-consent is a NextAuth-side outcome: the googleOAuth body carries no consent field for AuthService to read", () => {
    expect(Object.keys(googleOAuthSchema.shape).filter((key) => /consent/i.test(key))).toEqual([]);
  });
});
