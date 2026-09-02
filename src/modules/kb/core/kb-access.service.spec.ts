import { KbAccessService } from "./kb-access.service";
import type { AccessService } from "../../access/access.service";
import type { CacheService } from "../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { KB_PERMISSIONS } from "../../rbac/permissions/kb";

function makeUser(over: Partial<CurrentUserContext>): CurrentUserContext {
  return {
    userId: "u1",
    orgId: "o1",
    role: "member",
    isOrgOwner: false,
    enabledModules: ["kb"],
    ...over,
  } as unknown as CurrentUserContext;
}

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v as object)) return [];
  seen.add(v as object);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : []),
  ];
}

describe("KbAccessService — KB_SPACE_VIEWER_PERMISSION constant (Task 2)", () => {
  it("'kb:spaces:view' is a real entry in the backend KB permission catalog", () => {
    expect(KB_PERMISSIONS.some((p) => p.name === "kb:spaces:view")).toBe(true);
  });

  it("the kbSpaceGrants grant-lookup query uses 'kb:spaces:view' as the permission key literal", async () => {
    const capturedConditions: unknown[] = [];

    const makeChain = () => {
      const chain: Record<string, jest.Mock> = {};
      chain.from = jest.fn(() => chain);
      chain.innerJoin = jest.fn(() => chain);
      chain.where = jest.fn((cond: unknown) => {
        capturedConditions.push(cond);
        return Promise.resolve([]);
      });
      return chain;
    };

    const db = {
      select: jest.fn(() => makeChain()),
      selectDistinct: jest.fn(() => makeChain()),
      query: {
        kbSpaces: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    };

    const access = {
      holds: jest.fn().mockResolvedValue(false),
      getPermissionsVersion: jest.fn().mockResolvedValue(1),
    } as unknown as AccessService;
    const cache = {
      cachedVersioned: jest.fn().mockImplementation(
        (_ns: unknown, _uid: unknown, fn: () => unknown) => fn(),
      ),
    } as unknown as CacheService;

    const svc = new KbAccessService(db as never, cache, access);

    const user: CurrentUserContext = {
      orgId: "org-t2",
      userId: "u-t2",
      role: "MEMBER",
      isOrgOwner: false,
      principal: { kind: "human-session", membershipId: 99, isOrgOwner: false },
    } as never;

    await svc.getAccessibleSpaceIds(user);

    const allVals = capturedConditions.flatMap((c) => sqlValues(c));
    expect(allVals).toContain("kb:spaces:view");
    expect(allVals).not.toContain("kb:space:viewer");
  });
});

describe("KbAccessService.isAdmin", () => {
  function makeService(holdsResult: boolean): KbAccessService {
    const db = {} as never;
    const cache = {} as CacheService;
    const access = { holds: jest.fn().mockResolvedValue(holdsResult) } as unknown as AccessService;
    return new KbAccessService(db, cache, access);
  }

  it("returns true when the seam grants kb:spaces:manage", async () => {
    expect(await makeService(true).isAdmin(makeUser({}))).toBe(true);
  });

  it("returns false when the seam denies kb:spaces:manage", async () => {
    expect(await makeService(false).isAdmin(makeUser({}))).toBe(false);
  });

  it("is true for an org owner who holds nothing explicitly — seam is sole authority", async () => {
    expect(
      await makeService(true).isAdmin(makeUser({ isOrgOwner: true })),
    ).toBe(true);
  });
});
