import {
  managedProductMemberships,
  managedProducts,
  projects,
} from "../../../db/schema";
import {
  MEMBERSHIP_ID,
  actor,
  PROD_ROW,
  PROJ_ROW,
  makeAccess,
  makeDb,
  makeResponses,
  makeSvc,
  renderParams,
} from "./__tests__/scope-directory-spec-helpers";

describe("ScopeDirectoryService — project membership gate (BSN-02-005)", () => {
  it("returns all org projects when build:manage scope is all, regardless of membershipId", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      actor(null), ["project:20"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("20");
  });

  it("omits all projects when build:manage scope is not all and membershipId is null (account-only principal)", async () => {
    const { db, calls } = makeDb(makeResponses());

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      actor(null), ["project:20"],
    );

    expect(result).toEqual([]);
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeUndefined();
  });

  it("binds the actor's membershipId in the project WHERE clause when build:manage is below all (reachability predicate)", async () => {
    const { db, calls } = makeDb(makeResponses([
      [projects, [[PROJ_ROW]]],
    ]));

    await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      actor(MEMBERSHIP_ID), ["project:20"],
    );

    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeDefined();
    expect(renderParams(projectCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("resolves project via reachability predicate in the project WHERE when build:manage is not all", async () => {
    const { db } = makeDb(makeResponses([
      [projects, [[PROJ_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      actor(MEMBERSHIP_ID), ["project:20"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("20");
  });

  it("project membership gate: guard bites — the reachability predicate in the project WHERE ensures non-members get no rows, and the DB returns nothing", async () => {
    const { db, calls } = makeDb(makeResponses([
      [projects, [[]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      actor(MEMBERSHIP_ID), ["project:20"],
    );

    expect(result).toEqual([]);
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeDefined();
    expect(renderParams(projectCall?.condition)).toContain(MEMBERSHIP_ID);
  });
});

describe("ScopeDirectoryService — product membership gate (BSN-02-005 product half)", () => {
  it("product membership guard bites: non-member gets no products and managedProducts is never queried", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      actor(MEMBERSHIP_ID), ["product:10"],
    );

    expect(result).toEqual([]);
    const membershipCall = calls.find((c) => c.table === managedProductMemberships);
    expect(membershipCall).toBeDefined();
    expect(renderParams(membershipCall?.condition)).toContain(MEMBERSHIP_ID);
    expect(calls.find((c) => c.table === managedProducts)).toBeUndefined();
  });

  it("build:manage all bypasses product membership: products returned without consulting managedProductMemberships", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      actor(null), ["product:10"],
    );

    expect(result).toHaveLength(1);
    expect(calls.find((c) => c.table === managedProductMemberships)).toBeUndefined();
  });

  it("product membership predicate is absent when build:manage is all even with a valid membershipId (negative gate)", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
    ]));

    await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      actor(MEMBERSHIP_ID), ["product:10"],
    );

    expect(calls.find((c) => c.table === managedProductMemberships)).toBeUndefined();
  });

  it("cross-tenant isolation: same numeric membershipId in two orgs yields predicates bound to their own org", async () => {
    const ORG_A = "org-a";
    const ORG_B = "org-b";
    const SHARED_MEMBERSHIP_ID = 99;

    const { db: dbA, calls: callsA } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
    ]));
    await makeSvc(dbA, makeAccess(null)).resolveScopeDirectory(
      actor(SHARED_MEMBERSHIP_ID, ORG_A), ["product:10"],
    );

    const { db: dbB, calls: callsB } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
    ]));
    await makeSvc(dbB, makeAccess(null)).resolveScopeDirectory(
      actor(SHARED_MEMBERSHIP_ID, ORG_B), ["product:10"],
    );

    const memberCallA = callsA.find((c) => c.table === managedProductMemberships);
    expect(memberCallA).toBeDefined();
    expect(renderParams(memberCallA?.condition)).toContain(ORG_A);
    expect(renderParams(memberCallA?.condition)).not.toContain(ORG_B);

    const memberCallB = callsB.find((c) => c.table === managedProductMemberships);
    expect(memberCallB).toBeDefined();
    expect(renderParams(memberCallB?.condition)).toContain(ORG_B);
    expect(renderParams(memberCallB?.condition)).not.toContain(ORG_A);
  });

  it("membershipId null with build:manage not all: product membership and product queries both skipped", async () => {
    const { db, calls } = makeDb(makeResponses());

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      actor(null), ["product:10"],
    );

    expect(result).toEqual([]);
    expect(calls.find((c) => c.table === managedProductMemberships)).toBeUndefined();
    expect(calls.find((c) => c.table === managedProducts)).toBeUndefined();
  });
});

describe("ScopeDirectoryService — product and project gates run independently (workspace type removed)", () => {
  it("product membership and project reachability checks both run when both types are requested together", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[{ managedProductId: 10 }]]],
      [managedProducts, [[PROD_ROW]]],
      [projects, [[PROJ_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      actor(MEMBERSHIP_ID), ["product:10", "project:20"],
    );

    expect(result).toHaveLength(2);
    expect(calls.find((c) => c.table === managedProductMemberships)).toBeDefined();
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeDefined();
    expect(renderParams(projectCall?.condition)).toContain(MEMBERSHIP_ID);
  });
});
