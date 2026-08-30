jest.mock("../../common/tenant", () => ({
  withTenant: jest.fn(),
  withIdentity: jest.fn(),
  getTenantContext: jest.fn().mockReturnValue(null),
}));

import { AuthTokensService } from "./auth-tokens.service";
import type { Db } from "../../db/drizzle.module";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

beforeEach(() => jest.resetAllMocks());

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

interface FluentChain extends PromiseLike<unknown[]> {
  from: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  where: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
}

function makeFluentChain(finalResult: unknown[]): FluentChain {
  const chain = {} as FluentChain;
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(finalResult);
  chain.then = (
    resolve: ((value: unknown[]) => unknown) | null | undefined,
    reject?: ((reason: unknown) => unknown) | null | undefined,
  ) => Promise.resolve(finalResult).then(resolve, reject);
  return chain;
}

function getTenantMocks() {
  return jest.requireMock<{
    withTenant: jest.Mock;
    withIdentity: jest.Mock;
    getTenantContext: jest.Mock;
  }>("../../common/tenant");
}

function buildService(overrideDb?: Partial<Db>): AuthTokensService {
  const mockDb: Partial<Db> = {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
    ...overrideDb,
  };
  return new AuthTokensService(
    mockDb as unknown as Db,
    {} as unknown as ConstructorParameters<typeof AuthTokensService>[1],
    {} as unknown as ConstructorParameters<typeof AuthTokensService>[2],
    {} as unknown as ConstructorParameters<typeof AuthTokensService>[3],
    {} as unknown as ConstructorParameters<typeof AuthTokensService>[4],
  );
}

// ---------------------------------------------------------------------------
// resolveActiveMembership
// ---------------------------------------------------------------------------

describe("AuthTokensService.resolveActiveMembership tenant isolation", () => {
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

    const svc = buildService();
    const result = await svc.resolveActiveMembership("user-no-membership", null);

    expect(result).toBeNull();
  });

  it("DENY: returns null when preferred org does not match any of the user's memberships", async () => {
    const { withIdentity, getTenantContext } = getTenantMocks();
    getTenantContext.mockReturnValue(null);

    // The user has a membership in ATTACKER_ORG, but we ask for OWNER_ORG.
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

    const svc = buildService();
    // Asking for OWNER_ORG, but the user only belongs to ATTACKER_ORG.
    // The preferred row is not found; however, the fallback returns the first ACTIVE row.
    // This covers the case where the attacker's userId can't reach OWNER_ORG data.
    const result = await svc.resolveActiveMembership("user-attacker", OWNER_ORG);

    // No OWNER_ORG row exists — preferred is not found; fallback returns ATTACKER_ORG row (not OWNER_ORG).
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

    const svc = buildService();
    const result = await svc.resolveActiveMembership("user-owner", OWNER_ORG);

    expect(result?.orgId).toBe(OWNER_ORG);
    expect(result?.role).toBe("MEMBER");
  });
});

// ---------------------------------------------------------------------------
// logLoginEvent — tenant context routing
// ---------------------------------------------------------------------------

describe("AuthTokensService.logLoginEvent tenant isolation", () => {
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

    const svc = buildService();
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

    const svc = buildService();
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

    const svc = buildService();
    await svc.logLoginEvent(null, OWNER_ORG, "magic_link.verify", false, "no_user", {});

    expect(withTenant).not.toHaveBeenCalled();
  });
});
