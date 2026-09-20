import {
  managedProductMemberships,
  managedProducts,
  pmWorkspaceMemberships,
  pmWorkspaces,
  projectMembers,
  projectTeamAssignments,
  projects,
} from "../../../db/schema";
import {
  MEMBERSHIP_ID,
  ORG,
  PROD_ROW,
  PROJ_ROW,
  USER,
  WS_ROW,
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
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      ORG, USER, null, ["project:20"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("20");
  });

  it("omits all projects when build:manage scope is not all and membershipId is null (account-only principal)", async () => {
    const { db, calls } = makeDb(makeResponses());

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, null, ["project:20"],
    );

    expect(result).toEqual([]);
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeUndefined();
  });

  it("binds the actor's membershipId in the membership queries when build:manage is below all", async () => {
    const { db, calls } = makeDb(makeResponses([
      [projectMembers, [[{ projectId: 20 }]]],
      [projectTeamAssignments, [[]]],
      [projects, [[PROJ_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["project:20"],
    );

    const memberCall = calls.find((c) => c.table === projectMembers);
    expect(memberCall).toBeDefined();
    expect(renderParams(memberCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("resolves project via direct project membership when build:manage is not all", async () => {
    const { db } = makeDb(makeResponses([
      [projectMembers, [[{ projectId: 20 }]]],
      [projectTeamAssignments, [[]]],
      [projects, [[PROJ_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["project:20"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("20");
  });

  it("project membership gate: guard bites — removing the membershipId filter would allow a non-member through, but the DB honours the predicate and returns nothing", async () => {
    const { db, calls } = makeDb(makeResponses([
      [projectMembers, [[]]],
      [projectTeamAssignments, [[]]],
      [projects, [[]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["project:20"],
    );

    expect(result).toEqual([]);
    const memberCall = calls.find((c) => c.table === projectMembers);
    expect(memberCall).toBeDefined();
    expect(renderParams(memberCall?.condition)).toContain(MEMBERSHIP_ID);
    const projectCall = calls.find((c) => c.table === projects);
    expect(projectCall).toBeDefined();
    expect(renderParams(projectCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("workspace membership is enforced: omits a workspace the caller is not a member of when build:manage is not all", async () => {
    const { db } = makeDb(makeResponses([
      [pmWorkspaceMemberships, [[{ pmWorkspaceId: "ws-1" }]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["workspace:ws-1", "workspace:ws-2"],
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ws-1");
  });

  it("workspace membership is enforced: omits all workspaces when membershipId is null and build:manage is not all", async () => {
    const { db, calls } = makeDb(makeResponses());

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, null, ["workspace:ws-1"],
    );

    expect(result).toEqual([]);
    const wsCall = calls.find((c) => c.table === pmWorkspaces);
    expect(wsCall).toBeUndefined();
  });

  it("workspace membership is not enforced when build:manage scope is all — returns all org workspaces without consulting pmWorkspaceMemberships", async () => {
    const { db, calls } = makeDb(makeResponses([
      [pmWorkspaces, [[WS_ROW, { pmWorkspaceId: "ws-2", name: "Other", status: "active" }]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      ORG, USER, null, ["workspace:ws-1", "workspace:ws-2"],
    );

    expect(result).toHaveLength(2);
    const wsMembershipCall = calls.find((c) => c.table === pmWorkspaceMemberships);
    expect(wsMembershipCall).toBeUndefined();
  });

});

describe("ScopeDirectoryService — product membership gate (BSN-02-005 product half)", () => {
  it("product membership guard bites: non-member gets no products and managedProducts is never queried", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
    ]));

    const result = await makeSvc(db, makeAccess(null)).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["product:10"],
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
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      ORG, USER, null, ["product:10"],
    );

    expect(result).toHaveLength(1);
    expect(calls.find((c) => c.table === managedProductMemberships)).toBeUndefined();
  });

  it("product membership predicate is absent when build:manage is all even with a valid membershipId (negative gate)", async () => {
    const { db, calls } = makeDb(makeResponses([
      [managedProducts, [[PROD_ROW]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    await makeSvc(db, makeAccess("all")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["product:10"],
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
      [pmWorkspaces, [[WS_ROW]]],
    ]));
    await makeSvc(dbA, makeAccess(null)).resolveScopeDirectory(
      ORG_A, USER, SHARED_MEMBERSHIP_ID, ["product:10"],
    );

    const { db: dbB, calls: callsB } = makeDb(makeResponses([
      [managedProductMemberships, [[]]],
    ]));
    await makeSvc(dbB, makeAccess(null)).resolveScopeDirectory(
      ORG_B, USER, SHARED_MEMBERSHIP_ID, ["product:10"],
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
      ORG, USER, null, ["product:10"],
    );

    expect(result).toEqual([]);
    expect(calls.find((c) => c.table === managedProductMemberships)).toBeUndefined();
    expect(calls.find((c) => c.table === managedProducts)).toBeUndefined();
  });
});

describe("ScopeDirectoryService — workspace membership gate (BSN-02-009 revoked access)", () => {
  it("binds the actor's membershipId in the pmWorkspaceMemberships query when build:manage is below all", async () => {
    const { db, calls } = makeDb(makeResponses([
      [pmWorkspaceMemberships, [[{ pmWorkspaceId: "ws-1" }]]],
      [pmWorkspaces, [[WS_ROW]]],
    ]));

    await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["workspace:ws-1"],
    );

    const membershipCall = calls.find((c) => c.table === pmWorkspaceMemberships);
    expect(membershipCall).toBeDefined();
    expect(renderParams(membershipCall?.condition)).toContain(MEMBERSHIP_ID);
  });

  it("binds the caller's orgId in the pmWorkspaceMemberships query (cross-tenant isolation)", async () => {
    const { db, calls } = makeDb(makeResponses([
      [pmWorkspaceMemberships, [[]]],
    ]));

    await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["workspace:ws-foreign"],
    );

    const membershipCall = calls.find((c) => c.table === pmWorkspaceMemberships);
    expect(membershipCall).toBeDefined();
    expect(renderParams(membershipCall?.condition)).toContain(ORG);
  });

  it("workspace membership and project membership lookups run even when both types are requested together", async () => {
    const { db, calls } = makeDb(makeResponses([
      [pmWorkspaceMemberships, [[{ pmWorkspaceId: "ws-1" }]]],
      [projectMembers, [[{ projectId: 20 }]]],
      [projectTeamAssignments, [[]]],
      [pmWorkspaces, [[WS_ROW]]],
      [projects, [[PROJ_ROW]]],
      [managedProducts, [[PROD_ROW]]],
    ]));

    const result = await makeSvc(db, makeAccess("own")).resolveScopeDirectory(
      ORG, USER, MEMBERSHIP_ID, ["workspace:ws-1", "project:20"],
    );

    expect(result).toHaveLength(2);
    expect(calls.find((c) => c.table === pmWorkspaceMemberships)).toBeDefined();
    expect(calls.find((c) => c.table === projectMembers)).toBeDefined();
  });
});
