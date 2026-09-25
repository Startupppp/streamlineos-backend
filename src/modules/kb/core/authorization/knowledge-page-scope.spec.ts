import * as fc from "fast-check";
import { eq } from "drizzle-orm";
import { kbPages } from "../../../../db/schema";
import {
  buildArticleRestrictionBranch,
  buildSharedWithMeScope,
  buildVisiblePageScope,
  permissionFingerprintOf,
} from "./knowledge-page-scope";
import {
  accessLevelsSatisfying,
  accessSatisfies,
  type KbActorStanding,
  type KbPageAction,
} from "./knowledge-authorization.types";
import { pageVisibleTo } from "../../retrieval/kb-page-visibility";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";

function legacyUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

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

const render = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(render).join(" ");
  if (typeof node !== "object") return String(node);
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return render(record.queryChunks);
  if (typeof record.value === "string" || Array.isArray(record.value)) return render(record.value);
  if (typeof record.name === "string") return record.name;
  return "";
};

const text = (node: unknown): string => render(node).replace(/\s+/g, " ").trim();

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

describe("the legacy visibility predicate these branches replace", () => {
  it("reaches neither an explicit grant nor an accessible space, so the new assertions are not render artifacts", () => {
    const legacy = text(pageVisibleTo(legacyUser(), [42]));
    expect(legacy).not.toContain("kb_page_grants");
    expect(legacy).not.toContain("space_id");
    expect(legacy).toContain("project_id");
  });
});

describe("buildSharedWithMeScope", () => {
  it("offers no scope at all to an actor with neither a membership nor a role, failing closed", () => {
    expect(
      buildSharedWithMeScope(makeStanding({ membershipId: null, roleSlugs: [] })),
    ).toBeNull();
  });

  it("requires a live grant scoped to the exact page, so visibility alone never satisfies it", () => {
    const scope = buildSharedWithMeScope(makeStanding());
    expect(scope).not.toBeNull();
    const rendered = text(scope?.predicate);
    expect(rendered.toLowerCase()).toContain("exists");
    expect(rendered).toContain("kb_page_grants");
    expect(rendered).not.toContain("visibility");
  });

  it("an org-visible page the actor can merely view, with no grant naming them, does not satisfy the predicate structure", () => {
    const scope = buildSharedWithMeScope(makeStanding());
    const rendered = text(scope?.predicate);
    expect(rendered.toLowerCase()).toContain("revoked_at");
    expect(rendered.toLowerCase()).toContain("is null");
  });

  it("excludes a page the actor owns from sharedWithMe even when a role grant would otherwise match", () => {
    const scope = buildSharedWithMeScope(makeStanding({ membershipId: 9 }));
    const rendered = text(scope?.predicate);
    expect(rendered).toContain("owner_membership_id");
    expect(rendered).toContain("created_by_membership_id");
  });

  it("excludes a page the actor created, identified by user id rather than membership", () => {
    const scope = buildSharedWithMeScope(makeStanding());
    const rendered = text(scope?.predicate);
    expect(rendered).toContain("created_by_id");
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
