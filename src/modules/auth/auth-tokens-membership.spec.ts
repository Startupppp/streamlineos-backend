import { AuthMembershipResolverService } from "./auth-membership-resolver.service";
import type { SessionsService } from "../sessions/sessions.service";

function buildSessions(overrides: Partial<SessionsService> = {}): SessionsService {
  return {
    create: jest.fn().mockResolvedValue("session-id"),
    enforceMaxSessions: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SessionsService;
}

function buildService(rows: Record<string, unknown>[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.innerJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue(rows);
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue(chain),
  };
  const db = {
    transaction: jest
      .fn()
      .mockImplementation(
        async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
      ),
  };
  const service = new AuthMembershipResolverService(
    db as never,
    {} as never,
  );
  return { service, db, tx };
}

describe("AuthMembershipResolverService preferred organization access", () => {
  const activeSibling = {
    orgId: "org-active",
    isOwner: false,
    role: "MEMBER",
    status: "ACTIVE",
    maxConcurrentSessions: null,
    orgOnboardingCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const suspendedPreferred = {
    orgId: "org-suspended",
    isOwner: false,
    role: "ADMIN",
    status: "SUSPENDED",
    maxConcurrentSessions: null,
    orgOnboardingCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("preserves a suspended preferred org so the user can choose a sibling", async () => {
    const { service } = buildService([activeSibling, suspendedPreferred]);

    await expect(
      service.resolveActiveMembership("user-1", "org-suspended", {
        honorSuspendedPreference: true,
      }),
    ).resolves.toBeNull();
  });

  it("retains automatic active fallback outside the interactive session flow", async () => {
    const { service } = buildService([activeSibling, suspendedPreferred]);

    await expect(
      service.resolveActiveMembership("user-1", "org-suspended"),
    ).resolves.toMatchObject({ orgId: "org-active", status: "ACTIVE" });
  });
});

describe("AuthMembershipResolverService createLoginSession — concurrent-session cap resolution", () => {
  it("skips the identity transaction for the concurrent-session cap when the caller supplies it, because resolving it twice cost an extra withIdentity round trip on every sign-in", async () => {
    const sessions = buildSessions();
    const svc = new AuthMembershipResolverService({} as never, sessions);
    const resolveSpy = jest.spyOn(svc, "resolveActiveMembership").mockResolvedValue(null);

    await svc.createLoginSession("user-1", {}, 3);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(sessions.enforceMaxSessions).toHaveBeenCalledWith("user-1", 3, "session-id");
  });

  it("skips session enforcement when the caller supplies null as the cap, preserving no-cap behaviour without a DB call", async () => {
    const sessions = buildSessions();
    const svc = new AuthMembershipResolverService({} as never, sessions);
    const resolveSpy = jest.spyOn(svc, "resolveActiveMembership").mockResolvedValue(null);

    await svc.createLoginSession("user-1", {}, null);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(sessions.enforceMaxSessions).not.toHaveBeenCalled();
  });

  it("falls back to resolving the cap from the DB when the caller omits the parameter, so every existing call site continues to enforce the cap", async () => {
    const sessions = buildSessions();
    const svc = new AuthMembershipResolverService({} as never, sessions);
    jest.spyOn(svc, "resolveActiveMembership").mockResolvedValue({
      orgId: "org-1",
      isOwner: false,
      role: "MEMBER",
      maxConcurrentSessions: 5,
      orgOnboardingCompletedAt: null,
      memberOnboardingCompletedAt: null,
    });

    await svc.createLoginSession("user-1", {});

    expect(sessions.enforceMaxSessions).toHaveBeenCalledWith("user-1", 5, "session-id");
  });
});
