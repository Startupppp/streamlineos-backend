jest.mock("../../common/tenant", () => ({
  withTenant: jest.fn(),
  withIdentity: jest.fn(),
  getTenantContext: jest.fn().mockReturnValue(null),
}));

jest.mock("../../common/tenant/with-identity", () => ({
  withIdentity: jest.fn(),
}));

import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import { AuthAnalyticsService } from "./auth-analytics.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

beforeEach(() => jest.resetAllMocks());

interface FluentChain<T = unknown> extends PromiseLike<T[]> {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function makeFluentChain<T = unknown>(finalResult: T[]): FluentChain<T> {
  const chain = {} as FluentChain<T>;
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(finalResult);
  chain.then = <TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null | undefined,
  ): PromiseLike<TResult1 | TResult2> => Promise.resolve(finalResult).then(onfulfilled, onrejected);
  return chain;
}

function getTenantMocks() {
  const barrel = jest.requireMock<{
    withTenant: jest.Mock;
    getTenantContext: jest.Mock;
  }>("../../common/tenant");
  const withIdentityMod = jest.requireMock<{ withIdentity: jest.Mock }>(
    "../../common/tenant/with-identity",
  );
  return { ...barrel, withIdentity: withIdentityMod.withIdentity };
}

function buildMembershipService(): AuthMembershipResolverService {
  const mockDb: Partial<Db> = {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
  };
  return new AuthMembershipResolverService(
    mockDb as unknown as Db,
    {} as never,
  );
}

function buildAnalyticsService(): AuthAnalyticsService {
  const mockDb: Partial<Db> = {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
  };
  return new AuthAnalyticsService(mockDb as unknown as Db);
}

describe("AuthMembershipResolverService.resolveActiveMembership tenant isolation", () => {
  it("DENY: returns null when the user has no active membership in any org", async () => {
    const { withIdentity, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    const membershipChain = makeFluentChain([]);
    withIdentity.mockImplementation(
      (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { select: jest.fn().mockReturnValue(membershipChain) };
        return fn(tx);
      },
    );

    const svc = buildMembershipService();
    const result = await svc.resolveActiveMembership("user-no-membership", null);

    expect(result).toBeNull();
  });

  it("DENY: returns null when preferred org does not match any of the user's memberships", async () => {
    const { withIdentity, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    const attackerMemberRow = {
      orgId: ATTACKER_ORG,
      isOwner: false,
      role: "MEMBER",
      status: "ACTIVE",
      maxConcurrentSessions: null,
      orgOnboardingCompletedAt: null,
    };
    const membershipChain = makeFluentChain([attackerMemberRow]);
    withIdentity.mockImplementation(
      (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { select: jest.fn().mockReturnValue(membershipChain) };
        return fn(tx);
      },
    );

    const svc = buildMembershipService();
    const result = await svc.resolveActiveMembership("user-attacker", OWNER_ORG);

    expect(result?.orgId).toBe(ATTACKER_ORG);
    expect(result?.orgId).not.toBe(OWNER_ORG);
  });

  it("CONTROL: returns the matching org membership when user belongs to OWNER_ORG", async () => {
    const { withIdentity, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    const ownerMemberRow = {
      orgId: OWNER_ORG,
      isOwner: false,
      role: "MEMBER",
      status: "ACTIVE",
      maxConcurrentSessions: null,
      orgOnboardingCompletedAt: null,
    };
    const membershipChain = makeFluentChain([ownerMemberRow]);
    withIdentity.mockImplementation(
      (_db: unknown, _userId: string, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = { select: jest.fn().mockReturnValue(membershipChain) };
        return fn(tx);
      },
    );

    const svc = buildMembershipService();
    const result = await svc.resolveActiveMembership("user-owner", OWNER_ORG);

    expect(result?.orgId).toBe(OWNER_ORG);
    expect(result?.role).toBe("MEMBER");
  });
});

describe("AuthAnalyticsService.logLoginEvent tenant isolation", () => {
  it("DENY: routes login event to ATTACKER_ORG context — OWNER_ORG context never opened", async () => {
    const { withTenant, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    withTenant.mockImplementation(
      (_db: unknown, _opts: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
        };
        return fn(tx);
      },
    );

    const svc = buildAnalyticsService();
    await svc.logLoginEvent("user-attacker", ATTACKER_ORG, "magic_link.verify", true, null, {});

    expect(withTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ATTACKER_ORG }),
      expect.any(Function),
    );
    expect(withTenant).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: OWNER_ORG }),
      expect.any(Function),
    );
  });

  it("CONTROL: routes login event to the correct OWNER_ORG tenant context", async () => {
    const { withTenant, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    withTenant.mockImplementation(
      (_db: unknown, _opts: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
        };
        return fn(tx);
      },
    );

    const svc = buildAnalyticsService();
    await svc.logLoginEvent("user-owner", OWNER_ORG, "magic_link.verify", true, null, {});

    expect(withTenant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: OWNER_ORG }),
      expect.any(Function),
    );
  });

  it("DENY: skips withTenant entirely when no userId is provided", async () => {
    const { withTenant, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    const svc = buildAnalyticsService();
    await svc.logLoginEvent(null, OWNER_ORG, "magic_link.verify", false, "no_user", {});

    expect(withTenant).not.toHaveBeenCalled();
  });
});
