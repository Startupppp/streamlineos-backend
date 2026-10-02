import { MembershipStateService } from "./membership-state.service";
import type { Db } from "../../db/drizzle.module";

const USER = "user-in-two-orgs";
const ORG_A = "org-a";
const ORG_B = "org-b";

function buildDb(): Db {
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(null),
    execute: () => Promise.resolve(undefined),
  } as unknown as Db;
}

describe("MembershipStateService resolves the acting membership per organization", () => {
  it("keys the cache entry by organization, so org A's answer is never served for org B", async () => {
    const service = new MembershipStateService(buildDb());

    jest
      .spyOn(
        service as unknown as {
          fetchMembershipState: (u: string, o: string) => Promise<unknown>;
        },
        "fetchMembershipState",
      )
      .mockImplementation(async (_userId: string, orgId: string) => ({
        active: true,
        isOwner: orgId === ORG_A,
        role: orgId === ORG_A ? "OWNER" : "MEMBER",
        membershipId: orgId === ORG_A ? 11 : 22,
      }));

    const inOrgA = await service.resolve(USER, ORG_A);
    const inOrgB = await service.resolve(USER, ORG_B);

    expect(inOrgA.membershipId).toBe(11);
    expect(inOrgB.membershipId).toBe(22);
    expect(inOrgA.isOwner).toBe(true);
    expect(inOrgB.isOwner).toBe(false);
    await expect(service.resolve(USER, ORG_A)).resolves.toMatchObject({ membershipId: 11 });
    await expect(service.resolve(USER, ORG_B)).resolves.toMatchObject({ membershipId: 22 });
  });

  it("serves the cached entry for the same organization without refetching", async () => {
    const service = new MembershipStateService(buildDb());

    const fetch = jest
      .spyOn(
        service as unknown as {
          fetchMembershipState: (u: string, o: string) => Promise<unknown>;
        },
        "fetchMembershipState",
      )
      .mockResolvedValue({
        active: true,
        isOwner: false,
        role: "MEMBER",
        membershipId: 11,
      });

    await service.resolve(USER, ORG_A);
    await service.resolve(USER, ORG_A);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports no membership id when the person has no row in that organization", async () => {
    const service = new MembershipStateService(buildDb());

    jest
      .spyOn(
        service as unknown as {
          fetchMembershipState: (u: string, o: string) => Promise<unknown>;
        },
        "fetchMembershipState",
      )
      .mockResolvedValue({
        active: false,
        isOwner: false,
        role: "",
        membershipId: null,
      });

    const state = await service.resolve(USER, ORG_B);

    expect(state.membershipId).toBeNull();
    expect(state.active).toBe(false);
  });
});

interface MembershipRow {
  membershipId: number;
  status: string;
  isOwner: boolean;
  role: string;
  userIsActive: boolean;
  userDeletedAt: Date | null;
  orgStatus: string;
  orgDeletedAt: Date | null;
}

const LIVE_ROW: MembershipRow = {
  membershipId: 11,
  status: "ACTIVE",
  isOwner: false,
  role: "MEMBER",
  userIsActive: true,
  userDeletedAt: null,
  orgStatus: "ACTIVE",
  orgDeletedAt: null,
};

function buildDbReturning(rows: MembershipRow[]): Db {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy"])
    chain[method] = () => chain;
  chain["limit"] = () => Promise.resolve(rows);
  const tx = { execute: async () => undefined, select: () => chain };
  return {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    execute: async () => undefined,
  } as unknown as Db;
}

async function resolveWithRow(partial: Partial<MembershipRow>) {
  const service = new MembershipStateService(buildDbReturning([{ ...LIVE_ROW, ...partial }]));
  return service.resolve(USER, ORG_A);
}

describe("MembershipStateService is the one definition of a live membership", () => {
  it("reports an active member of a live organization as active", async () => {
    const state = await resolveWithRow({});
    expect(state).toEqual({
      active: true,
      isOwner: false,
      role: "MEMBER",
      membershipId: 11,
    });
  });

  it.each([
    ["a suspended membership", { status: "SUSPENDED" }],
    ["a membership that has left", { status: "LEFT" }],
    ["an invited-but-not-active membership", { status: "INVITED" }],
    ["a deactivated user account", { userIsActive: false }],
    ["a soft-deleted user account", { userDeletedAt: new Date() }],
    ["an organization that is not active", { orgStatus: "SUSPENDED" }],
    ["a soft-deleted organization", { orgDeletedAt: new Date() }],
  ] as const)("denies %s", async (_label, partial) => {
    const state = await resolveWithRow(partial);
    expect(state.active).toBe(false);
  });

  it("denies an owner whose membership is suspended, owner flag notwithstanding", async () => {
    const state = await resolveWithRow({ status: "SUSPENDED", isOwner: true });
    expect(state.active).toBe(false);
    expect(state.isOwner).toBe(true);
  });

  it("denies when there is no membership row at all", async () => {
    const service = new MembershipStateService(buildDbReturning([]));

    await expect(service.resolve(USER, ORG_B)).resolves.toEqual({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
  });

  it("propagates a failed read instead of caching a denial, so the next request asks the database again", async () => {
    let failing = true;
    const healthy = buildDbReturning([LIVE_ROW]);
    const db = {
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        if (failing) throw new Error("connection reset");
        return healthy.transaction(fn);
      },
      execute: async () => undefined,
    } as unknown as Db;
    const service = new MembershipStateService(db);

    await expect(service.resolve(USER, ORG_A)).rejects.toThrow("connection reset");
    failing = false;
    await expect(service.resolve(USER, ORG_A)).resolves.toMatchObject({ active: true });
  });

  it("still denies, without throwing, when the read succeeds and finds nothing", async () => {
    await expect(
      new MembershipStateService(buildDbReturning([])).resolve(USER, ORG_A),
    ).resolves.toEqual({
      active: false,
      isOwner: false,
      role: "",
      membershipId: null,
    });
  });
});
