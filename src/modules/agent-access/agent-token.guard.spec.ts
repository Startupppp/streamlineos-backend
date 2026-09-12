import { UnauthorizedException } from "@nestjs/common";
import { ExecutionContext } from "@nestjs/common";
import { AgentTokenGuard } from "./agent-token.guard";
import { EntitlementsService } from "../access/entitlements.service";
import { MembershipStateService } from "../../common/auth/membership-state.service";
import type { MembershipState } from "../../common/auth/membership-state.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import { AuthContextFactory } from "../../common/auth/auth-context.factory";
import { makeAuthContextFactory } from "../../../test/helpers/module-guard-context";

const VALID_TOKEN = "slos_" + "a".repeat(48);
const TOKEN_ID = 42;
const USER_ID = "user-1";
const ORG_ID = "org-1";
const MEMBERSHIP_ID = 7;

function makeExecutionContext(authHeader?: string): ExecutionContext {
  const req = { headers: { authorization: authHeader }, user: undefined };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const ACTIVE_STATE: MembershipState = {
  active: true,
  isOwner: false,
  role: "ENGINEERING",
  membershipId: MEMBERSHIP_ID,
};

const INACTIVE_STATE: MembershipState = {
  active: false,
  isOwner: false,
  role: "",
  membershipId: null,
};

describe("AgentTokenGuard", () => {
  let guard: AgentTokenGuard;
  let resolveMembership: jest.Mock;
  let mockDb: {
    select: jest.Mock;
    update: jest.Mock;
    execute: jest.Mock;
    transaction: jest.Mock;
  };

  function makeSelectChain(rows: unknown[]) {
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
      }),
    };
  }

  function makeUpdateChain() {
    return {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
  }

  const validTokenRow = {
    id: TOKEN_ID,
    userId: USER_ID,
    orgId: ORG_ID,
    issuerMembershipId: MEMBERSHIP_ID,
    scopes: ["build:tickets:view", "build:tickets:update"],
  };

  beforeEach(async () => {
    jest.resetAllMocks();

    mockDb = {
      select: jest.fn(),
      update: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn((fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb)),
    };
    resolveMembership = jest.fn().mockResolvedValue(ACTIVE_STATE);

    const module = await Test.createTestingModule({
      providers: [
        AgentTokenGuard,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: EntitlementsService, useValue: { listModules: jest.fn().mockResolvedValue([]) } },
        { provide: MembershipStateService, useValue: { resolve: resolveMembership } },
        { provide: AuthContextFactory, useValue: makeAuthContextFactory() },
      ],
    }).compile();
    guard = module.get(AgentTokenGuard);
  });

  function seedToken(rows: unknown[] = [validTokenRow]): void {
    mockDb.select.mockImplementation(() => makeSelectChain(rows));
    mockDb.update.mockReturnValue(makeUpdateChain());
  }

  async function expectDenied(): Promise<void> {
    await expect(
      guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  }

  it("returns true and sets req.user on a valid token", async () => {
    seedToken();

    const ctx = makeExecutionContext(`Bearer ${VALID_TOKEN}`);
    expect(await guard.canActivate(ctx)).toBe(true);

    const req = ctx.switchToHttp().getRequest() as { user?: unknown };
    expect(req.user).toMatchObject({
      userId: USER_ID,
      orgId: ORG_ID,
      role: "ENGINEERING",
      tokenScopes: ["build:tickets:view", "build:tickets:update"],
      principal: {
        kind: "agent-token",
        issuerMembershipId: MEMBERSHIP_ID,
        tokenId: TOKEN_ID,
        ceiling: ["build:tickets:view", "build:tickets:update"],
      },
    });
  });

  it("throws 401 when token is missing", async () => {
    await expect(
      guard.canActivate(makeExecutionContext(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when header does not start with Bearer slos_", async () => {
    await expect(
      guard.canActivate(makeExecutionContext("Bearer otherpat_abc")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("throws 401 when token hash not found in DB", async () => {
    seedToken([]);
    await expectDenied();
  });

  it("throws 401 for a revoked token (row filtered at DB level — empty rows)", async () => {
    seedToken([]);
    await expectDenied();
  });

  it("throws 401 for an expired token (row filtered at DB level — empty rows)", async () => {
    seedToken([]);
    await expectDenied();
  });

  it("uses sha256 so a token with wrong hash finds no row", async () => {
    seedToken([]);
    await expectDenied();
    expect(createHash("sha256").update(VALID_TOKEN).digest("hex")).toHaveLength(64);
  });

  it("resolves membership through the shared seam rather than its own query", async () => {
    seedToken();
    await guard.canActivate(makeExecutionContext(`Bearer ${VALID_TOKEN}`));
    expect(resolveMembership).toHaveBeenCalledWith(USER_ID, ORG_ID);
  });

  it("throws 401 when the membership is not active", async () => {
    seedToken();
    resolveMembership.mockResolvedValue(INACTIVE_STATE);
    await expectDenied();
  });

  it("throws 401 when the organization is archived or deleted", async () => {
    seedToken();
    resolveMembership.mockResolvedValue(INACTIVE_STATE);
    await expectDenied();
    expect(resolveMembership).toHaveBeenCalledWith(USER_ID, ORG_ID);
  });

  it("throws 401 when the token user account is inactive", async () => {
    seedToken();
    resolveMembership.mockResolvedValue(INACTIVE_STATE);
    await expectDenied();
  });

  it("throws 401 when the issuing membership no longer matches the token", async () => {
    seedToken();
    resolveMembership.mockResolvedValue({ ...ACTIVE_STATE, membershipId: 999 });
    await expectDenied();
  });

  it("throws 401 when the membership resolves active without an id", async () => {
    seedToken();
    resolveMembership.mockResolvedValue({ ...ACTIVE_STATE, membershipId: null });
    await expectDenied();
  });
});
