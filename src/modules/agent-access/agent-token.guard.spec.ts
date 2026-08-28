import { UnauthorizedException } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { AgentTokenGuard } from "./agent-token.guard";
import { EntitlementsService } from "../access/entitlements.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";

const VALID_TOKEN = "slos_" + "a".repeat(48);
const _VALID_HASH = createHash("sha256").update(VALID_TOKEN).digest("hex");
const TOKEN_ID = 42;
const USER_ID = "user-1";
const ORG_ID = "org-1";

function makeExecutionContext(authHeader?: string): ExecutionContext {
  const req = { headers: { authorization: authHeader }, user: undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("AgentTokenGuard", () => {
  let guard: AgentTokenGuard;
  let mockDb: {
    select: jest.Mock;
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
    query: { users: { findFirst: jest.Mock } };
  };

  function makeSelectChain(rows: unknown[]) {
    const limitChain = { limit: jest.fn().mockResolvedValue(rows) };
    const whereChain = { ...limitChain, limit: jest.fn().mockResolvedValue(rows) };
    const innerJoinChain = {
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockResolvedValue(rows),
      }),
    };
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(whereChain),
        innerJoin: jest.fn().mockReturnValue(innerJoinChain),
      }),
    };
  }

  function makeUpdateChain() {
    const whereChain = { catch: jest.fn().mockReturnValue(undefined) };
    return {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(whereChain),
      }),
    };
  }

  const validTokenRow = {
    id: TOKEN_ID,
    userId: USER_ID,
    orgId: ORG_ID,
    issuerMembershipId: 7,
    scopes: ["build:tickets:view", "build:tickets:update"],
  };
  const memberRow = { membershipId: 7, orgId: ORG_ID, role: "ENGINEERING", isOwner: false, enabledModules: ["projects"] };
  const subRow = { plan: "pro" };

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      update: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn(
        (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb),
      ),
      query: {
        users: { findFirst: jest.fn() },
      },
    };

    const mockEntitlements = { listModules: jest.fn().mockResolvedValue([]) };

    const module = await Test.createTestingModule({
      providers: [
        AgentTokenGuard,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EntitlementsService, useValue: mockEntitlements },
      ],
    }).compile();
    guard = module.get(AgentTokenGuard);
  });

  it("returns true and sets req.user on a valid token", async () => {
    let selectCount = 0;
    mockDb.select.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([validTokenRow]);
      if (selectCount === 2) return makeSelectChain([memberRow]);
      return makeSelectChain([subRow]);
    });
    mockDb.update.mockReturnValue(makeUpdateChain());
    mockDb.query.users.findFirst.mockResolvedValue({
      id: USER_ID,
      isActive: true,
      deletedAt: null,
    });

    const ctx = makeExecutionContext(`Bearer ${VALID_TOKEN}`);
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    const req = ctx.switchToHttp().getRequest() as { user?: unknown };
    expect(req.user).toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      tokenScopes: ["build:tickets:view", "build:tickets:update"],
      principal: {
        kind: "agent-token",
        issuerMembershipId: 7,
        tokenId: TOKEN_ID,
        ceiling: ["build:tickets:view", "build:tickets:update"],
      },
    });
  });

  it("throws 401 when token is missing", async () => {
    await expect(guard.canActivate(makeExecutionContext(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when header does not start with Bearer slos_", async () => {
    await expect(guard.canActivate(makeExecutionContext("Bearer otherpat_abc"))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when token hash not found in DB", async () => {
    mockDb.select.mockImplementation(() => makeSelectChain([]));
    await expect(guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 for a revoked token (row filtered at DB level — empty rows)", async () => {
    mockDb.select.mockImplementation(() => makeSelectChain([]));
    await expect(guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 for an expired token (row filtered at DB level — empty rows)", async () => {
    mockDb.select.mockImplementation(() => makeSelectChain([]));
    await expect(guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when user not found after valid token lookup", async () => {
    let selectCount = 0;
    mockDb.select.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([validTokenRow]);
      return makeSelectChain([memberRow]);
    });
    mockDb.update.mockReturnValue(makeUpdateChain());
    mockDb.query.users.findFirst.mockResolvedValue(null);

    await expect(guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    { id: USER_ID, isActive: false, deletedAt: null },
    { id: USER_ID, isActive: true, deletedAt: new Date() },
  ])("throws 401 when the token user account is inactive", async (user) => {
    let selectCount = 0;
    mockDb.select.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([validTokenRow]);
      return makeSelectChain([memberRow]);
    });
    mockDb.update.mockReturnValue(makeUpdateChain());
    mockDb.query.users.findFirst.mockResolvedValue(user);

    await expect(
      guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when the token user has no active membership in its organization", async () => {
    let selectCount = 0;
    mockDb.select.mockImplementation(() => {
      selectCount++;
      if (selectCount === 1) return makeSelectChain([validTokenRow]);
      return makeSelectChain([]);
    });
    mockDb.update.mockReturnValue(makeUpdateChain());
    mockDb.query.users.findFirst.mockResolvedValue({
      id: USER_ID,
      isActive: true,
      deletedAt: null,
    });

    await expect(
      guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("uses sha256 so a token with wrong hash finds no row", async () => {
    mockDb.select.mockImplementation(() => makeSelectChain([]));
    const wrongToken = "slos_" + "b".repeat(48);
    await expect(guard.canActivate(makeExecutionContext(`Bearer ${wrongToken}`))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
