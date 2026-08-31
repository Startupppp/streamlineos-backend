import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (
      _db: unknown,
      fn: (tx: unknown) => unknown,
      _opts: unknown,
    ) => fn(_db),
  ),
}));

const ORG_ID = "org-test";
const USER_ID = "user-test";

function makeChainReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy", "limit"]) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
  return chain;
}

function makeDb(row: Record<string, unknown> | undefined) {
  return {
    select: () => makeChainReturning(row ? [row] : []),
    query: {},
  };
}

function makeCache(): CacheService {
  return {
    get: jest.fn(async () => null),
    set: jest.fn(),
    invalidate: jest.fn(),
    invalidateNamespace: jest.fn(),
    cachedVersioned: jest.fn(
      async (_ns: string, _key: string, fn: () => Promise<unknown>) => fn(),
    ),
  } as unknown as CacheService;
}

async function buildService(db: unknown): Promise<MembershipStateService> {
  const module = await Test.createTestingModule({
    providers: [
      MembershipStateService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: makeCache() },
    ],
  }).compile();
  return module.get(MembershipStateService);
}

describe("suspended/departed member authority denial (item C)", () => {
  it("returns active=false for a SUSPENDED membership — suspended member cannot exercise authority", async () => {
    const db = makeDb({
      membershipId: 7,
      status: "SUSPENDED",
      isOwner: false,
      role: "MEMBER",
      userIsActive: true,
      userDeletedAt: null,
      orgStatus: "ACTIVE",
      orgDeletedAt: null,
    });
    const service = await buildService(db);
    const state = await service.resolve(USER_ID, ORG_ID);
    expect(state.active).toBe(false);
    expect(state.membershipId).toBe(7);
  });

  it("returns active=false for a LEFT (departed) membership", async () => {
    const db = makeDb({
      membershipId: 8,
      status: "LEFT",
      isOwner: false,
      role: "MEMBER",
      userIsActive: true,
      userDeletedAt: null,
      orgStatus: "ACTIVE",
      orgDeletedAt: null,
    });
    const service = await buildService(db);
    const state = await service.resolve(USER_ID, ORG_ID);
    expect(state.active).toBe(false);
  });

  it("returns active=true for an ACTIVE membership with live org and user — bite check", async () => {
    const db = makeDb({
      membershipId: 9,
      status: "ACTIVE",
      isOwner: false,
      role: "MEMBER",
      userIsActive: true,
      userDeletedAt: null,
      orgStatus: "ACTIVE",
      orgDeletedAt: null,
    });
    const service = await buildService(db);
    const state = await service.resolve(USER_ID, ORG_ID);
    expect(state.active).toBe(true);
  });

  it("returns active=false when org is ARCHIVED even if membership status is ACTIVE", async () => {
    const db = makeDb({
      membershipId: 10,
      status: "ACTIVE",
      isOwner: false,
      role: "MEMBER",
      userIsActive: true,
      userDeletedAt: null,
      orgStatus: "ARCHIVED",
      orgDeletedAt: new Date(),
    });
    const service = await buildService(db);
    const state = await service.resolve(USER_ID, ORG_ID);
    expect(state.active).toBe(false);
  });

  it("isOwner=true does NOT override status — a suspended owner is still inactive (owner-bypass hazard)", async () => {
    const db = makeDb({
      membershipId: 11,
      status: "SUSPENDED",
      isOwner: true,
      role: "OWNER",
      userIsActive: true,
      userDeletedAt: null,
      orgStatus: "ACTIVE",
      orgDeletedAt: null,
    });
    const service = await buildService(db);
    const state = await service.resolve(USER_ID, ORG_ID);
    expect(state.active).toBe(false);
    expect(state.isOwner).toBe(true);
  });
});
