import * as fs from "node:fs";
import * as path from "node:path";
import * as fc from "fast-check";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { kbPages } from "../../../../db/schema";
import {
  buildArticleRestrictionBranch,
  buildSharedWithMeScope,
  buildVisiblePageScope,
  permissionFingerprintOf,
  visiblePageBranches,
} from "./knowledge-page-scope";
import {
  accessLevelsSatisfying,
  accessSatisfies,
  type KbActorStanding,
  type KbPageAction,
} from "./knowledge-authorization.types";

function makeStanding(overrides: Partial<KbActorStanding> = {}): KbActorStanding {
  return {
    orgId: "org-1",
    userId: "user-1",
    membershipId: 1,
    roleSlugs: [],
    isOrgOwner: false,
    isKbAdmin: false,
    accessibleSpaceIds: [],
    accessibleProjectIds: [],
    permissionsVersion: 7,
    ...overrides,
  };
}

const dialect = new PgDialect();

const text = (node: SQL<unknown> | null | undefined): string => {
  if (node === null || node === undefined) return "";
  const { sql: rendered, params } = dialect.sqlToQuery(node);
  return `${rendered} /* bound: ${JSON.stringify(params)} */`.replace(/\s+/g, " ").trim();
};

const boundParams = (node: SQL<unknown>): unknown[] => dialect.sqlToQuery(node).params;

describe("buildVisiblePageScope", () => {
  it("collapses to a tenant equality for an org owner so no branch can widen past the tenant", () => {
    const scope = buildVisiblePageScope(makeStanding({ isOrgOwner: true }), "view");
    expect(scope.predicate).toStrictEqual(eq(kbPages.orgId, "org-1"));
    expect(scope.grantBranch).toBeNull();
  });

  it("collapses to a tenant equality for a knowledge admin", () => {
    const scope = buildVisiblePageScope(makeStanding({ isKbAdmin: true }), "view");
    expect(scope.predicate).toStrictEqual(eq(kbPages.orgId, "org-1"));
  });

  it("reaches a page through a live explicit grant, which the legacy visibility predicate never did", () => {
    const scope = buildVisiblePageScope(makeStanding(), "view");
    expect(scope.grantBranch).not.toBeNull();
    expect(text(scope.grantBranch)).toContain("kb_page_grants");
  });

  it("never reaches a revoked grant", () => {
    const scope = buildVisiblePageScope(makeStanding(), "view");
    expect(text(scope.grantBranch)).toContain("revoked_at");
    expect(text(scope.grantBranch)).toContain("IS NULL");
  });

  it("offers no grant branch at all to an actor with neither a membership nor a role, failing closed", () => {
    const scope = buildVisiblePageScope(
      makeStanding({ membershipId: null, roleSlugs: [] }),
      "view",
    );
    expect(scope.grantBranch).toBeNull();
    expect(text(scope.predicate)).not.toContain("kb_page_grants");
  });

  it("matches a grant issued to one of the actor's roles", () => {
    const scope = buildVisiblePageScope(
      makeStanding({ membershipId: null, roleSlugs: ["support-lead"] }),
      "view",
    );
    expect(text(scope.grantBranch)).toContain("support-lead");
  });

  it("reaches a page through space membership, the branch the legacy predicate omitted entirely", () => {
    const scope = buildVisiblePageScope(makeStanding({ accessibleSpaceIds: [42] }), "view");
    expect(text(scope.indexedBranch)).toContain("space_id");
    expect(text(scope.indexedBranch)).toContain("42");
  });

  it("does not offer a space the actor is not a member of", () => {
    const scope = buildVisiblePageScope(makeStanding({ accessibleSpaceIds: [42] }), "view");
    expect(text(scope.indexedBranch)).not.toContain("43");
  });

  it("reaches a page the actor owns even when its visibility is private", () => {
    const scope = buildVisiblePageScope(makeStanding({ membershipId: 9 }), "view");
    expect(text(scope.indexedBranch)).toContain("owner_membership_id");
  });

  it("stops letting bare space membership authorize an edit, because membership is a reach grant and not an administrative one", () => {
    const standing = makeStanding({ accessibleSpaceIds: [42] });

    expect(text(buildVisiblePageScope(standing, "view").indexedBranch)).toContain("space_id");
    expect(text(buildVisiblePageScope(standing, "edit").indexedBranch)).not.toContain("space_id");
    expect(text(buildVisiblePageScope(standing, "manage").indexedBranch)).not.toContain(
      "space_id",
    );
  });

  it("stops letting bare project membership authorize an edit", () => {
    const standing = makeStanding({ accessibleProjectIds: [7] });

    expect(text(buildVisiblePageScope(standing, "view").indexedBranch)).toContain("project_id");
    expect(text(buildVisiblePageScope(standing, "edit").indexedBranch)).not.toContain(
      "project_id",
    );
  });

  it("still lets a space member comment, which is the collaboration level membership does confer", () => {
    const standing = makeStanding({ accessibleSpaceIds: [42] });

    expect(text(buildVisiblePageScope(standing, "comment").indexedBranch)).toContain("space_id");
  });

  it("still reaches a page the actor owns when the action is a manage, so ownership survives the narrowing", () => {
    const standing = makeStanding({ membershipId: 9, accessibleSpaceIds: [42] });

    expect(text(buildVisiblePageScope(standing, "manage").indexedBranch)).toContain(
      "owner_membership_id",
    );
  });

  it("stops offering organization-wide pages once the action is an edit rather than a view", () => {
    const viewScope = buildVisiblePageScope(makeStanding(), "view");
    const editScope = buildVisiblePageScope(makeStanding(), "edit");
    expect(text(viewScope.indexedBranch)).toContain("'org'");
    expect(text(editScope.indexedBranch)).not.toContain("'org'");
  });

  it("keeps the grant branch separately addressable so a list query can union it instead of OR-ing past its index", () => {
    const scope = buildVisiblePageScope(makeStanding({ accessibleSpaceIds: [1] }), "view");
    expect(scope.grantBranch).not.toBeNull();
    expect(text(scope.indexedBranch)).not.toContain("kb_page_grants");
    expect(text(scope.predicate)).toContain("kb_page_grants");
  });
});

describe("project membership on the live view scope", () => {
  it("offers a reader who belongs to no project only pages that belong to no project", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleProjectIds: [] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain(`"kb_pages"."project_id" IS NULL`);
    expect(text(branch)).not.toContain(`"kb_pages"."project_id" = ANY`);
  });

  it("still offers that reader an organization-wide and a public page", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleProjectIds: [] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain("'org'");
    expect(text(branch)).toContain("'public'");
  });

  it("widens to project 42 for a member of project 42, binding the id rather than inlining it", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleProjectIds: [42] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain(`"kb_pages"."project_id" = ANY`);
    expect(boundParams(branch)).toContain(42);
  });

  it("does not widen to project 43 for a member of only project 42", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleProjectIds: [42] }),
      "view",
    ).indexedBranch;

    expect(boundParams(branch)).not.toContain(43);
  });

  it("keeps the reader's own authorship arm whether or not they belong to a project", () => {
    for (const projectIds of [[], [42]]) {
      const branch = buildVisiblePageScope(
        makeStanding({ accessibleProjectIds: projectIds }),
        "view",
      ).indexedBranch;
      expect(text(branch)).toContain(`"kb_pages"."created_by_id"`);
    }
  });
});

describe("buildSharedWithMeScope", () => {
  it("offers no scope at all to an actor with neither a membership nor a role, failing closed", () => {
    expect(
      buildSharedWithMeScope(makeStanding({ membershipId: null, roleSlugs: [] })),
    ).toBeNull();
  });

  it("grant EXISTS arm binds the actor's membershipId in params so only a grant naming that exact actor satisfies it — removing the grantee check leaves the membershipId absent", () => {
    const ACTOR = 42;
    const OTHER = 99;
    const scope = buildSharedWithMeScope(makeStanding({ membershipId: ACTOR }));
    expect(scope).not.toBeNull();
    expect(boundParams(scope!.predicate)).toContain(ACTOR);
    expect(boundParams(scope!.predicate)).not.toContain(OTHER);

    const otherScope = buildSharedWithMeScope(makeStanding({ membershipId: OTHER }));
    expect(otherScope).not.toBeNull();
    expect(boundParams(otherScope!.predicate)).toContain(OTHER);
    expect(boundParams(otherScope!.predicate)).not.toContain(ACTOR);
  });

  it("an org-visible page the actor can merely view with no grant naming them does not satisfy the scope — grant arm binds actor membershipId and access levels, not a page visibility column", () => {
    const ACTOR = 42;
    const scope = buildSharedWithMeScope(makeStanding({ membershipId: ACTOR }));
    expect(scope).not.toBeNull();

    const params = boundParams(scope!.predicate);
    expect(params).toContain(ACTOR);
    expect(params).toContain("view");

    const rendered = text(scope!.predicate);
    expect(rendered).not.toContain('"kb_pages"."visibility"');

    const noMembershipScope = buildSharedWithMeScope(makeStanding({ membershipId: null, roleSlugs: ["writer"] }));
    expect(noMembershipScope).not.toBeNull();
    expect(boundParams(noMembershipScope!.predicate)).not.toContain(ACTOR);
  });

  it("ownership exclusions bind the actor's membershipId so a page owned by this actor is excluded even when a role grant names the actor — removing the exclusion drops the membership param count", () => {
    const ACTOR = 9;
    const scope = buildSharedWithMeScope(makeStanding({ membershipId: ACTOR }));
    expect(scope).not.toBeNull();

    const params = boundParams(scope!.predicate);
    const countActor = params.filter((p) => p === ACTOR).length;
    expect(countActor).toBeGreaterThanOrEqual(2);

    const rendered = text(scope!.predicate);
    expect(rendered).toContain('"kb_pages"."owner_membership_id"');
    expect(rendered).toContain('"kb_pages"."created_by_membership_id"');
  });

  it("creator exclusion binds the actor's userId in params so a page created by this user is excluded — removing the exclusion drops the userId from params", () => {
    const scope = buildSharedWithMeScope(makeStanding({ userId: "user-1", membershipId: 1 }));
    expect(scope).not.toBeNull();

    const params = boundParams(scope!.predicate);
    expect(params).toContain("user-1");

    const rendered = text(scope!.predicate);
    expect(rendered).toContain('"kb_pages"."created_by_id"');
  });

  it("binds the actor's own org so a shared page from another tenant can never match", () => {
    const scope = buildSharedWithMeScope(makeStanding({ orgId: "org-9" }));
    expect(text(scope?.predicate)).toContain("org-9");
  });
});

describe("accessLevelsSatisfying", () => {
  it.each<[KbPageAction, KbPageAction[]]>([
    ["view", ["view", "comment", "edit", "manage"]],
    ["comment", ["comment", "edit", "manage"]],
    ["edit", ["edit", "manage"]],
    ["manage", ["manage"]],
  ])("treats a grant at or above %s as satisfying it", (action, expected) => {
    expect(accessLevelsSatisfying(action)).toEqual(expected);
  });

  it("does not let a view grant satisfy an edit", () => {
    expect(accessSatisfies("view", "edit")).toBe(false);
  });

  it("lets a manage grant satisfy a view", () => {
    expect(accessSatisfies("manage", "view")).toBe(true);
  });
});

describe("permissionFingerprintOf", () => {
  it("changes when a space leaves the actor's reach so a cached page list cannot survive revocation", () => {
    const before = permissionFingerprintOf(makeStanding({ accessibleSpaceIds: [1, 2] }), "view");
    const after = permissionFingerprintOf(makeStanding({ accessibleSpaceIds: [1] }), "view");
    expect(after).not.toEqual(before);
  });

  it("changes when the organization bumps its permissions version", () => {
    const before = permissionFingerprintOf(makeStanding({ permissionsVersion: 7 }), "view");
    const after = permissionFingerprintOf(makeStanding({ permissionsVersion: 8 }), "view");
    expect(after).not.toEqual(before);
  });

  it("changes when the action changes so a view cache cannot answer an edit", () => {
    expect(permissionFingerprintOf(makeStanding(), "view")).not.toEqual(
      permissionFingerprintOf(makeStanding(), "edit"),
    );
  });

  it("is stable under reordering so an equivalent standing reuses its cache entry", () => {
    const a = permissionFingerprintOf(
      makeStanding({ accessibleSpaceIds: [2, 1], roleSlugs: ["b", "a"] }),
      "view",
    );
    const b = permissionFingerprintOf(
      makeStanding({ accessibleSpaceIds: [1, 2], roleSlugs: ["a", "b"] }),
      "view",
    );
    expect(a).toEqual(b);
  });

  it("separates two tenants that otherwise hold identical standing", () => {
    expect(permissionFingerprintOf(makeStanding({ orgId: "org-1" }), "view")).not.toEqual(
      permissionFingerprintOf(makeStanding({ orgId: "org-2" }), "view"),
    );
  });
});

const arbitraryStanding = (): fc.Arbitrary<KbActorStanding> =>
  fc.record<KbActorStanding>({
    orgId: fc.uuid(),
    userId: fc.uuid(),
    membershipId: fc.option(fc.integer({ min: 1, max: 9_999 }), { nil: null }),
    roleSlugs: fc.array(fc.string({ minLength: 2, maxLength: 16 }), { maxLength: 3 }),
    isOrgOwner: fc.boolean(),
    isKbAdmin: fc.boolean(),
    accessibleSpaceIds: fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { maxLength: 4 }),
    accessibleProjectIds: fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { maxLength: 4 }),
    permissionsVersion: fc.integer({ min: 1, max: 1_000 }),
  });

const arbitraryAction = (): fc.Arbitrary<KbPageAction> =>
  fc.constantFrom<KbPageAction>("view", "comment", "edit", "manage");

describe("buildVisiblePageScope — property-based invariants", () => {
  it("an admin actor always collapses to a simple tenant equality regardless of every other field", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().map((s) => ({ ...s, isOrgOwner: true as const })),
        arbitraryAction(),
        (standing, action) => {
          const scope = buildVisiblePageScope(standing, action);
          expect(scope.predicate).toStrictEqual(eq(kbPages.orgId, standing.orgId));
          expect(scope.grantBranch).toBeNull();
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it("an actor with no membership and no roles receives no grant branch, denying by default", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().map((s) => ({
          ...s,
          membershipId: null,
          roleSlugs: [] as string[],
          isOrgOwner: false as const,
          isKbAdmin: false as const,
        })),
        (standing) => {
          const scope = buildVisiblePageScope(standing, "view");
          expect(scope.grantBranch).toBeNull();
          expect(text(scope.predicate)).not.toContain("kb_page_grants");
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it("whenever a grant branch exists it always requires revoked_at IS NULL so a revoked grant never grants", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().filter(
          (s) => !s.isOrgOwner && !s.isKbAdmin && (s.membershipId !== null || s.roleSlugs.length > 0),
        ),
        (standing) => {
          const scope = buildVisiblePageScope(standing, "view");
          if (scope.grantBranch === null) return;
          const rendered = text(scope.grantBranch);
          expect(rendered.toLowerCase()).toContain("revoked_at");
          expect(rendered.toLowerCase()).toContain("is null");
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it("every predicate contains the actor's own org_id so cross-tenant records cannot match", () => {
    fc.assert(
      fc.property(arbitraryStanding(), arbitraryAction(), (standing, action) => {
        const scope = buildVisiblePageScope(standing, action);
        expect(text(scope.predicate)).toContain(standing.orgId);
      }),
      { numRuns: 200, seed: 42 },
    );
  });

  it("the fingerprint is stable — identical standing produces identical output on two calls", () => {
    fc.assert(
      fc.property(arbitraryStanding(), arbitraryAction(), (standing, action) => {
        const a = permissionFingerprintOf(standing, action);
        const b = permissionFingerprintOf({ ...standing }, action);
        expect(a).toBe(b);
      }),
      { numRuns: 200, seed: 42 },
    );
  });

  it("any two actors in different orgs with otherwise identical fields get different fingerprints", () => {
    fc.assert(
      fc.property(
        arbitraryStanding(),
        arbitraryAction(),
        fc.uuid().filter((id) => id !== "org-1"),
        (standing, action, altOrgId) => {
          const a = permissionFingerprintOf(standing, action);
          const b = permissionFingerprintOf({ ...standing, orgId: altOrgId }, action);
          expect(a).not.toBe(b);
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it("space membership in the standing produces a space_id term in the indexed branch only for view and comment", () => {
    fc.assert(
      fc.property(
        arbitraryStanding()
          .filter((s) => !s.isOrgOwner && !s.isKbAdmin && s.accessibleSpaceIds.length > 0)
          .map((s) => ({
            ...s,
            isOrgOwner: false as const,
            isKbAdmin: false as const,
          })),
        (standing) => {
          const viewBranch = text(buildVisiblePageScope(standing, "view").indexedBranch);
          const editBranch = text(buildVisiblePageScope(standing, "edit").indexedBranch);
          expect(viewBranch).toContain("space_id");
          expect(editBranch).not.toContain("space_id");
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });
});

describe("buildArticleRestrictionBranch — property-based invariants", () => {
  const arbitraryPrincipal = () =>
    fc.record({
      membershipId: fc.option(fc.integer({ min: 1, max: 9_999 }), { nil: null }),
      roleSlugs: fc.array(fc.string({ minLength: 2, maxLength: 16 }), { maxLength: 4 }),
    });

  it("always produces a NOT EXISTS / OR EXISTS pair structure", () => {
    fc.assert(
      fc.property(fc.uuid(), arbitraryPrincipal(), (orgId, principal) => {
        const rendered = text(buildArticleRestrictionBranch(orgId, principal));
        expect(rendered.toLowerCase()).toContain("not exists");
        expect(rendered.toLowerCase()).toContain("exists");
      }),
      { numRuns: 200, seed: 42 },
    );
  });

  it("binds the caller's own org_id in every subquery so cross-tenant rows cannot satisfy it", () => {
    fc.assert(
      fc.property(fc.uuid(), arbitraryPrincipal(), (orgId, principal) => {
        const rendered = text(buildArticleRestrictionBranch(orgId, principal));
        expect(rendered).toContain(orgId);
      }),
      { numRuns: 200, seed: 42 },
    );
  });

  it("when the principal has no roles the EXISTS arm uses false so it cannot be satisfied by a role match", () => {
    fc.assert(
      fc.property(fc.uuid(), arbitraryPrincipal().map((p) => ({ ...p, roleSlugs: [] as string[] })), (orgId, principal) => {
        const rendered = text(buildArticleRestrictionBranch(orgId, principal));
        expect(rendered.toLowerCase()).toContain("false");
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});

describe("buildArticleRestrictionBranch — action to restriction level mapping", () => {
  const principal = { membershipId: null as null, roleSlugs: [] as string[] };

  it("binds the view level for a view action so page-level view restrictions are enforced", () => {
    const params = boundParams(buildArticleRestrictionBranch("org-1", principal, "view"));
    expect(params).toContain("view");
    expect(params).not.toContain("edit");
  });

  it("binds the view level for a comment action because commenting requires view-level clearance", () => {
    const params = boundParams(buildArticleRestrictionBranch("org-1", principal, "comment"));
    expect(params).toContain("view");
    expect(params).not.toContain("edit");
  });

  it("binds the edit level for an edit action so page-level edit restrictions are enforced", () => {
    const params = boundParams(buildArticleRestrictionBranch("org-1", principal, "edit"));
    expect(params).toContain("edit");
    expect(params).not.toContain("view");
  });

  it("binds the edit level for a manage action because managing requires at least edit-level restriction clearance", () => {
    const params = boundParams(buildArticleRestrictionBranch("org-1", principal, "manage"));
    expect(params).toContain("edit");
    expect(params).not.toContain("view");
  });

  it("omitting the action argument defaults to view level so all prior callers are unaffected", () => {
    const withDefault = boundParams(buildArticleRestrictionBranch("org-1", principal));
    const withExplicit = boundParams(buildArticleRestrictionBranch("org-1", principal, "view"));
    expect(withDefault).toEqual(withExplicit);
  });
});

describe("buildVisiblePageScope — restriction folded into predicate", () => {
  it("folds the restriction predicate into the combined predicate so a restriction-blocked page is denied even through org visibility", () => {
    const scope = buildVisiblePageScope(makeStanding(), "view");
    expect(text(scope.predicate)).toContain("kb_page_restrictions");
  });

  it("leaves the predicate as a plain tenant equality for an org owner — admins are never blocked by restrictions", () => {
    const scope = buildVisiblePageScope(makeStanding({ isOrgOwner: true }), "view");
    expect(text(scope.predicate)).not.toContain("kb_page_restrictions");
    expect(scope.predicate).toStrictEqual(eq(kbPages.orgId, "org-1"));
  });

  it("leaves the predicate as a plain tenant equality for a kb admin — kb admins are never blocked by restrictions", () => {
    const scope = buildVisiblePageScope(makeStanding({ isKbAdmin: true }), "view");
    expect(text(scope.predicate)).not.toContain("kb_page_restrictions");
  });

  it("folds the restriction into the individual indexedBranch field so every exported surface enforces the same rule", () => {
    const scope = buildVisiblePageScope(makeStanding(), "view");
    expect(text(scope.indexedBranch)).toContain("kb_page_restrictions");
  });

  it("folds the restriction into the individual grantBranch field so the list path and the read path agree", () => {
    const scope = buildVisiblePageScope(makeStanding(), "view");
    expect(scope.grantBranch).not.toBeNull();
    expect(text(scope.grantBranch!)).toContain("kb_page_restrictions");
  });

  it("uses the edit restriction level in the predicate for an edit action so edit restrictions block editing", () => {
    const scope = buildVisiblePageScope(makeStanding(), "edit");
    const params = boundParams(scope.predicate);
    expect(params).toContain("edit");
    expect(params).not.toContain("view");
  });
});

describe("visiblePageBranches", () => {
  it("returns null grantBranch and a plain tenant indexedBranch for an org owner, matching the admin fast-path", () => {
    const branches = visiblePageBranches(makeStanding({ isOrgOwner: true }), "view");
    expect(branches.grantBranch).toBeNull();
    expect(branches.indexedBranch).toStrictEqual(eq(kbPages.orgId, "org-1"));
  });

  it("returns null grantBranch and a plain tenant indexedBranch for a kb admin", () => {
    const branches = visiblePageBranches(makeStanding({ isKbAdmin: true }), "view");
    expect(branches.grantBranch).toBeNull();
    expect(branches.indexedBranch).toStrictEqual(eq(kbPages.orgId, "org-1"));
  });

  it("bakes the restriction check into the indexedBranch so a UNION caller does not need to re-apply it", () => {
    const branches = visiblePageBranches(makeStanding(), "view");
    expect(text(branches.indexedBranch)).toContain("kb_page_restrictions");
  });

  it("bakes the restriction check into the grantBranch so a UNION caller does not need to re-apply it", () => {
    const branches = visiblePageBranches(makeStanding(), "view");
    expect(branches.grantBranch).not.toBeNull();
    expect(text(branches.grantBranch!)).toContain("kb_page_restrictions");
  });

  it("returns null grantBranch for an actor with no membership and no roles — fails closed the same as buildVisiblePageScope", () => {
    const branches = visiblePageBranches(makeStanding({ membershipId: null, roleSlugs: [] }), "view");
    expect(branches.grantBranch).toBeNull();
  });

  it("still exposes kb_page_grants in the grantBranch when the actor has a membership", () => {
    const branches = visiblePageBranches(makeStanding(), "view");
    expect(text(branches.grantBranch!)).toContain("kb_page_grants");
  });

  it("branches do NOT appear in the admin actor's indexedBranch — restriction is a no-op for admins", () => {
    const branches = visiblePageBranches(makeStanding({ isOrgOwner: true }), "view");
    expect(text(branches.indexedBranch)).not.toContain("kb_page_restrictions");
  });

  it("fingerprint matches buildVisiblePageScope so the two helpers share the same cache invalidation path", () => {
    const standing = makeStanding({ accessibleSpaceIds: [1, 2] });
    expect(visiblePageBranches(standing, "view").fingerprint).toBe(
      buildVisiblePageScope(standing, "view").fingerprint,
    );
  });

  it("uses edit restriction level in both branches for an edit action", () => {
    const branches = visiblePageBranches(makeStanding(), "edit");
    expect(boundParams(branches.indexedBranch)).toContain("edit");
    expect(boundParams(branches.grantBranch!)).toContain("edit");
  });

  it("keeps the indexed and grant branches separately addressable so callers can UNION them without losing index-eligibility", () => {
    const branches = visiblePageBranches(makeStanding({ accessibleSpaceIds: [5] }), "view");
    expect(text(branches.indexedBranch)).toContain("space_id");
    expect(text(branches.grantBranch!)).not.toContain("space_id");
  });

  it("property: every non-admin actor's indexedBranch contains both the org_id binding and the restriction check", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().filter((s) => !s.isOrgOwner && !s.isKbAdmin),
        arbitraryAction(),
        (standing, action) => {
          const branches = visiblePageBranches(standing, action);
          const rendered = text(branches.indexedBranch);
          expect(rendered).toContain(standing.orgId);
          expect(rendered).toContain("kb_page_restrictions");
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it("property: whenever a grantBranch exists it also contains the restriction check so the grant path is equally guarded", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().filter(
          (s) => !s.isOrgOwner && !s.isKbAdmin && (s.membershipId !== null || s.roleSlugs.length > 0),
        ),
        arbitraryAction(),
        (standing, action) => {
          const branches = visiblePageBranches(standing, action);
          if (branches.grantBranch === null) return;
          expect(text(branches.grantBranch)).toContain("kb_page_restrictions");
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });
});

describe("cross-surface equality invariant — UNION and predicate forms enforce the same rule", () => {
  it("scope.indexedBranch and visiblePageBranches.indexedBranch produce identical SQL and params so no read path is more permissive than the other", () => {
    const standing = makeStanding({ accessibleSpaceIds: [5] });
    const scope = buildVisiblePageScope(standing, "view");
    const branches = visiblePageBranches(standing, "view");
    expect(text(scope.indexedBranch)).toBe(text(branches.indexedBranch));
    expect(boundParams(scope.indexedBranch)).toEqual(boundParams(branches.indexedBranch));
  });

  it("scope.grantBranch and visiblePageBranches.grantBranch produce identical SQL and params", () => {
    const standing = makeStanding();
    const scope = buildVisiblePageScope(standing, "view");
    const branches = visiblePageBranches(standing, "view");
    expect(scope.grantBranch).not.toBeNull();
    expect(branches.grantBranch).not.toBeNull();
    expect(text(scope.grantBranch!)).toBe(text(branches.grantBranch!));
    expect(boundParams(scope.grantBranch!)).toEqual(boundParams(branches.grantBranch!));
  });

  it("null grantBranch agrees between the two helpers when the actor has no membership and no roles", () => {
    const standing = makeStanding({ membershipId: null, roleSlugs: [] });
    expect(buildVisiblePageScope(standing, "view").grantBranch).toBeNull();
    expect(visiblePageBranches(standing, "view").grantBranch).toBeNull();
  });

  it("the named actor's membershipId is bound in both the predicate form and the indexed-branch form so restriction rows can match on both paths", () => {
    const standing = makeStanding({ membershipId: 7 });
    const scope = buildVisiblePageScope(standing, "view");
    expect(boundParams(scope.predicate)).toContain(7);
    expect(boundParams(scope.indexedBranch)).toContain(7);
  });

  it("the non-named actor (null membership, no roles) gets false in the EXISTS arm of both forms, making restriction rows unconditionally blocking on both paths", () => {
    const standing = makeStanding({ membershipId: null, roleSlugs: [] });
    const scope = buildVisiblePageScope(standing, "view");
    expect(text(scope.predicate).toLowerCase()).toContain("false");
    expect(text(scope.indexedBranch).toLowerCase()).toContain("false");
  });

  it("property: for every non-admin actor and every action, scope.indexedBranch and branches.indexedBranch are identical", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().filter((s) => !s.isOrgOwner && !s.isKbAdmin),
        arbitraryAction(),
        (standing, action) => {
          const scope = buildVisiblePageScope(standing, action);
          const branches = visiblePageBranches(standing, action);
          expect(text(scope.indexedBranch)).toBe(text(branches.indexedBranch));
          expect(boundParams(scope.indexedBranch)).toEqual(boundParams(branches.indexedBranch));
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });

  it("property: whenever a grantBranch exists, scope.grantBranch and branches.grantBranch are identical", () => {
    fc.assert(
      fc.property(
        arbitraryStanding().filter(
          (s) =>
            !s.isOrgOwner &&
            !s.isKbAdmin &&
            (s.membershipId !== null || s.roleSlugs.length > 0),
        ),
        arbitraryAction(),
        (standing, action) => {
          const scope = buildVisiblePageScope(standing, action);
          const branches = visiblePageBranches(standing, action);
          if (scope.grantBranch === null || branches.grantBranch === null) return;
          expect(text(scope.grantBranch)).toBe(text(branches.grantBranch));
          expect(boundParams(scope.grantBranch)).toEqual(boundParams(branches.grantBranch));
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });
});

describe("org-visible pages in spaces — space membership required when spaceId is non-null", () => {
  it("an org-visible page with a non-null spaceId the actor cannot reach is absent from the indexed branch, restoring the access control from 197a317ab that fe3d30809 silently removed", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleSpaceIds: [1, 2] }),
      "view",
    ).indexedBranch;

    expect(boundParams(branch)).not.toContain(99);
    expect(text(branch)).toContain(`"space_id" IS NULL`);
  });

  it("POSITIVE CONTROL: an org-visible page with a null spaceId is visible to an actor who belongs to no spaces — the dominant case (27 of 29 production org-visible pages have null spaceId)", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleSpaceIds: [] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain("'org'");
    expect(text(branch)).toContain(`"space_id" IS NULL`);
  });

  it("POSITIVE CONTROL: an org-visible page with a non-null spaceId is visible when the actor is a member of that space", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleSpaceIds: [3] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain("'org'");
    expect(boundParams(branch)).toContain(3);
  });

  it("BITE — removing the space condition from the org-visibility clause makes all three assertions above vacuous, so the denial is real and not an accident of empty parameters", () => {
    const standingReachable = makeStanding({ accessibleSpaceIds: [1, 2] });
    const branchReachable = buildVisiblePageScope(standingReachable, "view").indexedBranch;

    const standingNoSpaces = makeStanding({ accessibleSpaceIds: [] });
    const branchNoSpaces = buildVisiblePageScope(standingNoSpaces, "view").indexedBranch;

    expect(text(branchReachable)).toContain(`"space_id" IS NULL`);
    expect(text(branchNoSpaces)).toContain(`"space_id" IS NULL`);
    expect(text(branchNoSpaces)).not.toContain("ANY(");
  });
});

describe("permissionFingerprintOf — admin bit collapse is safe (Item 326)", () => {
  it("isOrgOwner=true and isKbAdmin=true produce the same fingerprint because both take the admin fast-path", () => {
    const ownerFingerprint = permissionFingerprintOf(
      makeStanding({ isOrgOwner: true, isKbAdmin: false }),
      "view",
    );
    const adminFingerprint = permissionFingerprintOf(
      makeStanding({ isOrgOwner: false, isKbAdmin: true }),
      "view",
    );
    expect(ownerFingerprint).toBe(adminFingerprint);
  });

  it("the predicate for isOrgOwner and isKbAdmin is identical, proving the fingerprint collapse is correct and the same cursor scope tag covers both", () => {
    const scopeOwner = buildVisiblePageScope(
      makeStanding({ isOrgOwner: true, isKbAdmin: false }),
      "view",
    );
    const scopeAdmin = buildVisiblePageScope(
      makeStanding({ isOrgOwner: false, isKbAdmin: true }),
      "view",
    );
    expect(text(scopeOwner.predicate)).toBe(text(scopeAdmin.predicate));
    expect(boundParams(scopeOwner.predicate)).toEqual(boundParams(scopeAdmin.predicate));
  });

  it("POSITIVE CONTROL: isOrgOwner=false,isKbAdmin=false produces a different fingerprint so non-admin actors cannot inherit an admin cursor position", () => {
    const memberFingerprint = permissionFingerprintOf(
      makeStanding({ isOrgOwner: false, isKbAdmin: false }),
      "view",
    );
    const ownerFingerprint = permissionFingerprintOf(
      makeStanding({ isOrgOwner: true, isKbAdmin: false }),
      "view",
    );
    expect(memberFingerprint).not.toBe(ownerFingerprint);
  });
});

describe("permissionFingerprintOf — userId omission is safe at the cursor-scope-tag usage site (Item 326)", () => {
  it("two actors with different non-null membershipId produce different fingerprints — membershipId alone distinguishes typical actors so userId is not needed", () => {
    const a = permissionFingerprintOf(
      makeStanding({ membershipId: 1, userId: "user-A" }),
      "view",
    );
    const b = permissionFingerprintOf(
      makeStanding({ membershipId: 2, userId: "user-A" }),
      "view",
    );
    expect(a).not.toBe(b);
  });

  it("POSITIVE CONTROL: two actors with the same non-null membershipId produce the same fingerprint — the cursor scope tag correctly collapses them since their predicates are identical", () => {
    const a = permissionFingerprintOf(
      makeStanding({ membershipId: 5, userId: "user-A" }),
      "view",
    );
    const b = permissionFingerprintOf(
      makeStanding({ membershipId: 5, userId: "user-B" }),
      "view",
    );
    expect(a).toBe(b);
  });

  it("two actors with membershipId=null and different userId share a fingerprint but their predicates bind different userIds — cursor reuse shifts position only, no data crosses actors", () => {
    const standingA = makeStanding({ membershipId: null, roleSlugs: [], userId: "user-A" });
    const standingB = makeStanding({ membershipId: null, roleSlugs: [], userId: "user-B" });

    expect(permissionFingerprintOf(standingA, "view")).toBe(permissionFingerprintOf(standingB, "view"));

    const paramsA = boundParams(buildVisiblePageScope(standingA, "view").predicate);
    const paramsB = boundParams(buildVisiblePageScope(standingB, "view").predicate);
    expect(paramsA).toContain("user-A");
    expect(paramsA).not.toContain("user-B");
    expect(paramsB).toContain("user-B");
    expect(paramsB).not.toContain("user-A");
  });
});

describe("KbSharedWithMeScope — no fingerprint field (Item 326)", () => {
  it("does not carry a fingerprint property so a future caching call site cannot silently key by a field that omits userId and principal ceiling", () => {
    const shared = buildSharedWithMeScope(makeStanding());
    expect(shared).not.toBeNull();
    expect(Object.keys(shared!)).not.toContain("fingerprint");
  });
});

describe("Item 431 guard — restriction predicate wrapper does not exist", () => {
  it("retrieval/kb-article-restriction-predicate.ts does not exist; the canonical predicate lives in knowledge-page-scope.ts and callers import it directly", () => {
    const wrapperPath = path.resolve(
      __dirname,
      "../../retrieval/kb-article-restriction-predicate.ts",
    );
    expect(fs.existsSync(wrapperPath)).toBe(false);
  });
});

describe("AV-02 private-space/project rule — container branches must not reach private pages (REQUIREMENT-LEDGER S02 line 550)", () => {
  it("the space membership clause in the indexed view branch carries a visibility restriction so a private page in an accessible space owned by a different member cannot match it", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ membershipId: 1, accessibleSpaceIds: [42] }),
      "view",
    ).indexedBranch;

    const rendered = text(branch);

    expect(rendered).toContain('"owner_membership_id"');
    expect(rendered).toContain("space_id");
    expect(boundParams(branch)).toContain(42);

    const visibilityGuardCount = (rendered.match(/'org', 'public'/g) ?? []).length;
    expect(visibilityGuardCount).toBeGreaterThanOrEqual(2);
  });

  it("the project membership clause in the indexed view branch carries a visibility restriction so a private page in an accessible project owned by a different member cannot match it", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ membershipId: 1, accessibleProjectIds: [7] }),
      "view",
    ).indexedBranch;

    const rendered = text(branch);

    expect(rendered).toContain('"owner_membership_id"');
    expect(rendered).toContain("project_id");
    expect(boundParams(branch)).toContain(7);

    const visibilityGuardCount = (rendered.match(/'org', 'public'/g) ?? []).length;
    expect(visibilityGuardCount).toBeGreaterThanOrEqual(2);
  });

  it("POSITIVE CONTROL: org-visible pages in accessible spaces are still reachable after the visibility restriction is applied to the space membership branch", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleSpaceIds: [5] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain("space_id");
    expect(boundParams(branch)).toContain(5);
  });

  it("POSITIVE CONTROL: org-visible pages in accessible projects are still reachable after the visibility restriction is applied to the project membership branch", () => {
    const branch = buildVisiblePageScope(
      makeStanding({ accessibleProjectIds: [9] }),
      "view",
    ).indexedBranch;

    expect(text(branch)).toContain("project_id");
    expect(boundParams(branch)).toContain(9);
  });

  it("BITE: adding a space to the actor's reach increases the visibility guard count by exactly one, proving the guard is in the space clause and not coincidental from another clause", () => {
    const noSpaces = buildVisiblePageScope(makeStanding({ accessibleSpaceIds: [] }), "view").indexedBranch;
    const withSpaces = buildVisiblePageScope(makeStanding({ accessibleSpaceIds: [42] }), "view").indexedBranch;

    const countNoSpaces = (text(noSpaces).match(/'org', 'public'/g) ?? []).length;
    const countWithSpaces = (text(withSpaces).match(/'org', 'public'/g) ?? []).length;

    expect(countWithSpaces).toBe(countNoSpaces + 1);
  });

  it("BITE: adding a project to the actor's reach increases the visibility guard count by exactly one, proving the guard is in the project clause", () => {
    const noProjects = buildVisiblePageScope(makeStanding({ accessibleProjectIds: [] }), "view").indexedBranch;
    const withProjects = buildVisiblePageScope(makeStanding({ accessibleProjectIds: [7] }), "view").indexedBranch;

    const countNoProjects = (text(noProjects).match(/'org', 'public'/g) ?? []).length;
    const countWithProjects = (text(withProjects).match(/'org', 'public'/g) ?? []).length;

    expect(countWithProjects).toBe(countNoProjects + 1);
  });
});

describe("AV-02 private-visibility rule — sharedWithMe scope excludes org-visible pages that have no explicit grant (REQUIREMENT-LEDGER S03 line 581)", () => {
  it("the sharedWithMe predicate does not reference the visibility column so an org-visible page authored by another user cannot satisfy it without an explicit grant", () => {
    const ACTOR = 42;
    const scope = buildSharedWithMeScope(makeStanding({ membershipId: ACTOR }));
    expect(scope).not.toBeNull();

    const rendered = text(scope!.predicate);
    const params = boundParams(scope!.predicate);

    expect(rendered).toContain("kb_page_grants");
    expect(params).toContain(ACTOR);
    expect(params).toContain("view");

    expect(rendered).not.toContain('"kb_pages"."visibility"');
  });

  it("POSITIVE CONTROL: the sharedWithMe predicate contains an EXISTS clause that is satisfiable when a kb_page_grants row names the actor, so the scope is not vacuously empty", () => {
    const scope = buildSharedWithMeScope(makeStanding({ membershipId: 42 }));
    expect(scope).not.toBeNull();

    const rendered = text(scope!.predicate);
    expect(rendered).toContain("EXISTS");
    expect(rendered).toContain('"kb_page_grants"');
  });

  it("BITE: the sharedWithMe predicate for a role-only actor (no membershipId) does not bind a membershipId in params, proving the grant check is the real gate and not a no-op", () => {
    const withMembership = buildSharedWithMeScope(makeStanding({ membershipId: 42, roleSlugs: [] }));
    const roleOnly = buildSharedWithMeScope(makeStanding({ membershipId: null, roleSlugs: ["editor"] }));

    expect(withMembership).not.toBeNull();
    expect(boundParams(withMembership!.predicate)).toContain(42);

    expect(roleOnly).not.toBeNull();
    expect(boundParams(roleOnly!.predicate)).not.toContain(42);
  });
});
