import { AuthTokensService } from "./auth-tokens.service";

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
  const service = new AuthTokensService(
    db as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, db, tx };
}

describe("AuthTokensService preferred organization access", () => {
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
    const { service, db, tx } = buildService([
      activeSibling,
      suspendedPreferred,
    ]);

    await expect(
      service.resolveActiveMembership("user-1", "org-suspended", {
        honorSuspendedPreference: true,
      }),
    ).resolves.toBeNull();
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("retains automatic active fallback outside the interactive session flow", async () => {
    const { service } = buildService([activeSibling, suspendedPreferred]);

    await expect(
      service.resolveActiveMembership("user-1", "org-suspended"),
    ).resolves.toMatchObject({ orgId: "org-active", status: "ACTIVE" });
  });
});
