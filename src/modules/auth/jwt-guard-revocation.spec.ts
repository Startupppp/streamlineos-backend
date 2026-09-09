import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import type { Db } from "../../db/drizzle.module";
import type { MembershipStateService } from "../../common/auth/membership-state.service";
import type { JwtKeyringService } from "../../common/auth/jwt-keyring.service";
import type { Redis } from "@upstash/redis";

const CLAIMS = { sub: "user-1", orgId: "org-1", sessionId: "sess-abc" };
const ACTIVE_STATE = { active: true, membershipId: 1, role: "MEMBER", isOwner: false };
const INACTIVE_STATE = { active: false, membershipId: 1, role: "MEMBER", isOwner: false };

function makeContext(): ExecutionContext {
  const req = {
    headers: { authorization: "Bearer a.b.c" },
    path: "/api/resource",
    url: "/api/resource",
    method: "GET",
  };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeFallbackDb(isRevoked: boolean): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ isRevoked }]),
        }),
      }),
    }),
  } as unknown as Db;
}

function makeThrowingDb(): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockRejectedValue(new Error("DB unavailable")),
        }),
      }),
    }),
  } as unknown as Db;
}

function buildGuard(opts: {
  tombstone?: boolean | null;
  membershipState?: { active: boolean; membershipId: number | null; role: string; isOwner: boolean };
  accountActive?: boolean;
  redisThrows?: boolean;
  db?: Db;
}): JwtAuthGuard {
  const {
    tombstone = null,
    membershipState = ACTIVE_STATE,
    accountActive = true,
    redisThrows = false,
    db = makeFallbackDb(false),
  } = opts;

  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(false),
  } as unknown as Reflector;

  const redis = {
    get: redisThrows
      ? jest.fn().mockRejectedValue(new Error("Redis unavailable"))
      : jest.fn().mockResolvedValue(tombstone),
  } as unknown as Redis;

  const membership = {
    isAccountActive: jest.fn().mockResolvedValue(accountActive),
    resolve: jest.fn().mockResolvedValue(membershipState),
  } as unknown as MembershipStateService;

  const keyring = {
    verifyToken: jest.fn().mockResolvedValue(CLAIMS),
  } as unknown as JwtKeyringService;

  return new JwtAuthGuard(reflector, db, redis, membership, keyring);
}

describe("JwtAuthGuard — revoked-session tombstone bite proofs", () => {
  it("NEUTER: no tombstone in Redis + DB says not-revoked → guard passes (Redis miss goes to DB)", async () => {
    const guard = buildGuard({ tombstone: null, db: makeFallbackDb(false) });
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
  });

  it("BITE: tombstone present in Redis → UnauthorizedException (revoked session denied)", async () => {
    const guard = buildGuard({ tombstone: true });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });

  it("database fallback: Redis throws → falls back to DB `is_revoked` flag; not-revoked DB row passes", async () => {
    const guard = buildGuard({ redisThrows: true, db: makeFallbackDb(false) });
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
  });

  it("database fallback: Redis throws AND DB says revoked → UnauthorizedException", async () => {
    const guard = buildGuard({ redisThrows: true, db: makeFallbackDb(true) });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });

  it("BITE: durably revoked row with no Redis tombstone → rejected (Redis miss falls through to DB)", async () => {
    const guard = buildGuard({ tombstone: null, db: makeFallbackDb(true) });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });

  it("BITE: Redis throws AND DB throws → rejected (double-failure fails closed)", async () => {
    const guard = buildGuard({ redisThrows: true, db: makeThrowingDb() });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });

  it("BITE: tombstone present → rejected and the database was NOT queried (hot path preserved)", async () => {
    const selectFn = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ isRevoked: false }]),
        }),
      }),
    });
    const db = { select: selectFn } as unknown as Db;
    const guard = buildGuard({ tombstone: true, db });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
    expect(selectFn).not.toHaveBeenCalled();
  });

  it("no tombstone and is_revoked=false → admitted, exactly one database read", async () => {
    const selectFn = jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ isRevoked: false }]),
        }),
      }),
    });
    const db = { select: selectFn } as unknown as Db;
    const guard = buildGuard({ tombstone: null, db });
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
    expect(selectFn).toHaveBeenCalledTimes(1);
  });
});

describe("JwtAuthGuard — inactive membership bite proofs", () => {
  it("NEUTER: active membership → guard passes (proves the membership check is not always denying)", async () => {
    const guard = buildGuard({ membershipState: ACTIVE_STATE });
    const result = await guard.canActivate(makeContext());
    expect(result).toBe(true);
  });

  it("BITE: inactive membership → ForbiddenException with ORG_MEMBERSHIP_INACTIVE code", async () => {
    const guard = buildGuard({ membershipState: INACTIVE_STATE });
    const error = await guard.canActivate(makeContext()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    const response = (error as ForbiddenException).getResponse();
    expect(response).toMatchObject({ code: "ORG_MEMBERSHIP_INACTIVE" });
  });

  it("suspended org owner is still denied — isOwner=true does not bypass inactive check", async () => {
    const guard = buildGuard({
      membershipState: { active: false, membershipId: 1, role: "OWNER", isOwner: true },
    });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(ForbiddenException);
  });
});

describe("JwtAuthGuard — account-level denial", () => {
  it("BITE: account inactive → UnauthorizedException (account check fires before membership)", async () => {
    const guard = buildGuard({ accountActive: false });
    await expect(guard.canActivate(makeContext())).rejects.toThrow(UnauthorizedException);
  });
});
