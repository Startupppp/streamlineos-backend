import { resolveProjectAccess } from "./project-access";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { MEMBER_STANDING, projectAccessRow, principalAccess, type ProjectAccessRow } from "../../__tests__/project-access-doubles";
import { queuedSelectDb } from "../../__tests__/project-access-db";

function user(isOrgOwner = false): CurrentUserContext {
  return {
    orgId: "org-1",
    userId: "u-1",
    role: "MEMBER",
    isOrgOwner,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, isOrgOwner),
  };
}

function measured(row: ProjectAccessRow) {
  const { db, select, findFirst } = queuedSelectDb({ selects: [[row]] });
  return { db, roundTrips: () => select.mock.calls.length + findFirst.mock.calls.length };
}

describe("resolveProjectAccess states its cost as a round-trip count, so a caller reads it here and a second query fails this suite rather than shipping", () => {
  it("costs one project row for an org owner, because the relationship columns ride on the same row", async () => {
    const { db, roundTrips } = measured(projectAccessRow());
    await expect(resolveProjectAccess(db, principalAccess(MEMBER_STANDING), user(true), 1)).resolves.toMatchObject({
      hasAccess: true,
      role: "OWNER",
    });
    expect(roundTrips()).toBe(1);
  });

  it("costs one project row for a direct member, with no separate membership or team query", async () => {
    const { db, roundTrips } = measured(projectAccessRow({ memberRole: "CONTRIBUTOR" }));
    await expect(resolveProjectAccess(db, principalAccess(MEMBER_STANDING), user(), 1)).resolves.toMatchObject({
      hasAccess: true,
    });
    expect(roundTrips()).toBe(1);
  });

  it("costs the same single row for a denied reader, so a denial is not cheaper or more expensive to detect than a grant", async () => {
    const { db, roundTrips } = measured(projectAccessRow());
    await expect(resolveProjectAccess(db, principalAccess(MEMBER_STANDING), user(), 1)).resolves.toMatchObject({
      hasAccess: false,
    });
    expect(roundTrips()).toBe(1);
  });

  it("asks scopeFor for build:view only when build:manage did not already settle the standing", async () => {
    const admin = principalAccess({ ...MEMBER_STANDING, "build:manage": "all" });
    await resolveProjectAccess(measured(projectAccessRow()).db, admin, user(), 1);
    expect(admin.scopeFor.mock.calls.map(([, key]) => key)).toEqual(["build:manage"]);

    const plain = principalAccess(MEMBER_STANDING);
    await resolveProjectAccess(measured(projectAccessRow()).db, plain, user(), 1);
    expect(plain.scopeFor.mock.calls.map(([, key]) => key)).toEqual(["build:manage", "build:view"]);
  });
});
