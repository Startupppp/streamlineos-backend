import { resolveProjectAccess } from "./project-access";
import type { Db } from "../../../db/drizzle.types";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

interface Counter {
  projectLookups: number;
  selects: number;
  permissionResolutions: number;
}

function makeCountingDb(counter: Counter, memberRows: readonly unknown[], teamRows: readonly unknown[]) {
  let selectIndex = 0;
  const chain = (rows: readonly unknown[]) => {
    const thenable = {
      from: () => thenable,
      innerJoin: () => thenable,
      where: () => thenable,
      limit: () => Promise.resolve(rows),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return thenable;
  };
  return {
    query: {
      projects: {
        findFirst: jest.fn(async () => {
          counter.projectLookups += 1;
          return { managerMembershipId: 999 };
        }),
      },
    },
    select: jest.fn(() => {
      counter.selects += 1;
      const rows = selectIndex === 0 ? memberRows : teamRows;
      selectIndex += 1;
      return chain(rows);
    }),
  } as unknown as Db;
}

function makeAccess(counter: Counter, permissions: string[]) {
  return {
    resolveUserPermissions: jest.fn(async () => {
      counter.permissionResolutions += 1;
      return new Set(permissions);
    }),
  } as unknown as AccessService;
}

function user(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orgId: "org-1",
    userId: "u-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 7 },
    ...overrides,
  } as unknown as CurrentUserContext;
}

function freshCounter(): Counter {
  return { projectLookups: 0, selects: 0, permissionResolutions: 0 };
}

describe("resolveProjectAccess states its cost as a round-trip count, so a caller reads it here and a fourth query fails this suite rather than shipping", () => {
  it("costs one project lookup and no membership query for an org owner, who is decided before either membership read is issued", async () => {
    const counter = freshCounter();
    const db = makeCountingDb(counter, [], []);

    await expect(resolveProjectAccess(db, makeAccess(counter, []), user({ isOrgOwner: true }), 1)).resolves.toEqual(
      { hasAccess: true, role: "OWNER" },
    );

    expect(counter.projectLookups).toBe(1);
    expect(counter.selects).toBe(0);
  });

  it("costs one project lookup, one permission resolution and no membership query for a build:manage holder", async () => {
    const counter = freshCounter();
    const db = makeCountingDb(counter, [], []);

    await expect(
      resolveProjectAccess(db, makeAccess(counter, ["build:manage"]), user(), 1),
    ).resolves.toEqual({ hasAccess: true, role: "OWNER" });

    expect(counter.projectLookups).toBe(1);
    expect(counter.permissionResolutions).toBe(1);
    expect(counter.selects).toBe(0);
  });

  it("costs one project lookup and no membership query for the project manager, identified from the project row already in hand", async () => {
    const counter = freshCounter();
    const db = makeCountingDb(counter, [], []);

    await expect(
      resolveProjectAccess(db, makeAccess(counter, []), user({ principal: { kind: "human-session", membershipId: 999 } }), 1),
    ).resolves.toEqual({ hasAccess: true, role: "MANAGER" });

    expect(counter.selects).toBe(0);
  });

  it("costs exactly two membership queries for a direct project member, issued together rather than in sequence", async () => {
    const counter = freshCounter();
    const db = makeCountingDb(counter, [{ role: "MEMBER" }], []);

    const result = await resolveProjectAccess(db, makeAccess(counter, []), user(), 1);

    expect(result.hasAccess).toBe(true);
    expect(counter.projectLookups).toBe(1);
    expect(counter.permissionResolutions).toBe(1);
    expect(counter.selects).toBe(2);
  });

  it("costs the same two membership queries for a denied reader, so a denial is not cheaper or more expensive to detect than a grant", async () => {
    const counter = freshCounter();
    const db = makeCountingDb(counter, [], []);

    const result = await resolveProjectAccess(db, makeAccess(counter, []), user(), 1);

    expect(result.hasAccess).toBe(false);
    expect(counter.projectLookups).toBe(1);
    expect(counter.selects).toBe(2);
  });

  it("never exceeds three database round trips on any path, which is the ceiling this suite exists to hold", async () => {
    for (const [memberRows, teamRows, isOrgOwner] of [
      [[{ role: "MEMBER" }], [], false],
      [[], [{ id: 1 }], false],
      [[], [], false],
      [[], [], true],
    ] as const) {
      const counter = freshCounter();
      const db = makeCountingDb(counter, memberRows, teamRows);
      await resolveProjectAccess(db, makeAccess(counter, []), user({ isOrgOwner }), 1);
      expect(counter.projectLookups + counter.selects).toBeLessThanOrEqual(3);
    }
  });
});
