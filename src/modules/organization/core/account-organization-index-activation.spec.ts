import { AccountOrganizationIndexService } from "./account-organization-index.service";

type TouchOutcome = "hit" | "miss" | "throw";

const LIVE_ROW = {
  orgId: "org-1",
  organizationName: "Acme",
  organizationSlug: "acme",
  membershipRole: "OWNER",
  membershipStatus: "ACTIVE",
  organizationStatus: "ACTIVE",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  region: null,
};

function buildService(options: {
  touches: readonly TouchOutcome[];
  liveRows?: unknown[];
}) {
  const touches = [...options.touches];
  const updateWhere = jest.fn();
  const selectLimit = jest.fn().mockResolvedValue(options.liveRows ?? []);

  const updateReturning = jest.fn().mockImplementation(() => {
    const next = touches.shift() ?? "miss";
    if (next === "throw") return Promise.reject(new Error("update failed"));
    return Promise.resolve(next === "hit" ? [{ orgId: "org-1" }] : []);
  });

  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        innerJoin: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: selectLimit }),
        }),
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: selectLimit }),
          limit: selectLimit,
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoUpdate: jest.fn().mockResolvedValue([]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: updateWhere.mockReturnValue({ returning: updateReturning }),
      }),
    }),
    delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
  };

  const db = {
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const service = new AccountOrganizationIndexService(db as never);
  return { service, db, tx, updateReturning, updateWhere };
}

describe("AccountOrganizationIndexService.activate — a projection failure is a value, never silence", () => {
  it("first touch updates a row → activated", async () => {
    const { service, updateReturning } = buildService({ touches: ["hit"] });

    await expect(service.activate("user-1", "org-1")).resolves.toEqual({
      status: "activated",
    });
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it("zero-row update then refresh then a hit → activated, and the refresh ran once", async () => {
    const { service, updateReturning, tx } = buildService({
      touches: ["miss", "hit"],
      liveRows: [LIVE_ROW],
    });

    await expect(service.activate("user-1", "org-1")).resolves.toEqual({
      status: "activated",
    });
    expect(updateReturning).toHaveBeenCalledTimes(2);
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it("still zero rows after the refresh → unprojected, and it does NOT throw", async () => {
    const { service, updateReturning } = buildService({
      touches: ["miss", "miss"],
      liveRows: [{ ...LIVE_ROW, orgId: "org-other" }],
    });

    await expect(service.activate("user-1", "org-1")).resolves.toEqual({
      status: "unprojected",
    });
    expect(updateReturning).toHaveBeenCalledTimes(2);
  });

  it("a throwing update → failed, carrying the reason", async () => {
    const { service } = buildService({ touches: ["throw"] });

    await expect(service.activate("user-1", "org-1")).resolves.toEqual({
      status: "failed",
      reason: "update failed",
    });
  });

  it("a throwing refresh → failed, and the second touch is never attempted", async () => {
    const { service, updateReturning, tx } = buildService({
      touches: ["miss"],
      liveRows: [LIVE_ROW],
    });
    tx.insert.mockImplementation(() => {
      throw new Error("refresh failed");
    });

    await expect(service.activate("user-1", "org-1")).resolves.toEqual({
      status: "failed",
      reason: "refresh failed",
    });
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it("touchLastActivated still reports the raw boolean for callers that only need the row count", async () => {
    const { service } = buildService({ touches: ["miss"] });

    await expect(service.touchLastActivated("user-1", "org-1")).resolves.toBe(false);
  });

  // Why an unprojected activation may never be reported as success: the preference the
  // session lands on is read from this same projection, so a missed stamp resolves a
  // DIFFERENT organization. `AuthMagicLinkService` signs the owner into whatever this returns.
  it("a stale preference survives an unprojected activation — the other org is still preferred", async () => {
    const { service } = buildService({
      touches: ["miss", "miss"],
      liveRows: [{ orgId: "org-other", cellId: "cell-1" }],
    });

    await expect(service.activate("user-1", "org-1")).resolves.toEqual({
      status: "unprojected",
    });
    await expect(service.resolvePreferredOrg("user-1")).resolves.toEqual({
      orgId: "org-other",
      cellId: "cell-1",
    });
  });
});
