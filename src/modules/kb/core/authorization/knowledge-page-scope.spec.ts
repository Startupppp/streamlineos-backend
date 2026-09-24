import { eq } from "drizzle-orm";
import { kbPages } from "../../../../db/schema";
import {
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
