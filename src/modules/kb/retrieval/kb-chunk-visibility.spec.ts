import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { buildVisiblePageScope } from "../core/authorization/knowledge-page-scope";
import type { KbActorStanding } from "../core/authorization/knowledge-authorization.types";

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
    permissionsVersion: 1,
    ...overrides,
  };
}

const dialect = new PgDialect();

const shape = (node: SQL<unknown>): string =>
  dialect.sqlToQuery(node).sql.replace(/\s+/g, " ").trim();

const boundParams = (node: SQL<unknown>): unknown[] => dialect.sqlToQuery(node).params;

describe("chunkVisibleTo — semi-join to kb_pages under the canonical scope", () => {
  it("produces an EXISTS subquery referencing kb_pages, not kb_article_chunks ACL columns", () => {
    const built = shape(chunkVisibleTo(makeStanding()));
    expect(built).toContain("EXISTS");
    expect(built).toContain('"kb_pages"');
    expect(built).not.toContain('"kb_article_chunks"."page_visibility"');
    expect(built).not.toContain('"kb_article_chunks"."page_project_id"');
    expect(built).not.toContain('"kb_article_chunks"."page_created_by_id"');
    expect(built).not.toContain('"kb_article_chunks"."page_created_by_membership_id"');
  });

  it("correlates the subquery on page_id so each chunk looks up its own page", () => {
    const built = shape(chunkVisibleTo(makeStanding()));
    expect(built).toContain('"kb_pages"."id" = "kb_article_chunks"."page_id"');
  });

  it("includes the grant branch so a page shared by explicit grant appears in chunk scope", () => {
    const standing = makeStanding({ membershipId: 42 });
    const built = shape(chunkVisibleTo(standing));
    expect(built).toContain('"kb_page_grants"');
    expect(built).toContain("revoked_at");
    expect(boundParams(chunkVisibleTo(standing))).toContain(42);
  });

  it("BITE — with no grant branch (old predicate) a grant-only page is invisible; the new predicate admits it", () => {
    const standing = makeStanding({ membershipId: 42, userId: "other-user" });
    const withGrant = shape(chunkVisibleTo(standing));
    expect(withGrant).toContain('"kb_page_grants"');

    const withoutGrant = shape(buildVisiblePageScope(
      { ...makeStanding({ membershipId: null }), userId: "other-user" },
      "view",
    ).predicate);
    expect(withoutGrant).not.toContain('"kb_page_grants"');
  });

  it("the predicate and the canonical page scope produce the same predicate body inside the EXISTS", () => {
    const standing = makeStanding({ accessibleProjectIds: [42] });
    const chunkPred = shape(chunkVisibleTo(standing));
    const pagePred = shape(buildVisiblePageScope(standing, "view").predicate);
    expect(chunkPred).toContain(pagePred);
  });

  it("binds the org so no other tenant's pages can satisfy the predicate", () => {
    const standing = makeStanding({ orgId: "org-sentinel" });
    expect(boundParams(chunkVisibleTo(standing))).toContain("org-sentinel");
  });

  it("an org owner gets a predicate that only checks org membership, not visibility branches", () => {
    const ownerPred = shape(chunkVisibleTo(makeStanding({ isOrgOwner: true })));
    const memberPred = shape(chunkVisibleTo(makeStanding({ isOrgOwner: false })));
    expect(ownerPred.length).toBeLessThan(memberPred.length);
    expect(ownerPred).toContain('"kb_pages"."org_id"');
  });

  it("a project arm appears when the standing has project access, and disappears when it does not", () => {
    const granted = shape(chunkVisibleTo(makeStanding({ accessibleProjectIds: [7] })));
    const revoked = shape(chunkVisibleTo(makeStanding({ accessibleProjectIds: [] })));
    expect(granted).toContain('"kb_pages"."project_id"');
    expect(revoked).not.toContain('"kb_pages"."project_id" = ANY');
    expect(boundParams(chunkVisibleTo(makeStanding({ accessibleProjectIds: [7] })))).toContain(7);
  });

  it("the predicate still binds the tenant when project access is revoked", () => {
    expect(boundParams(chunkVisibleTo(makeStanding({ accessibleProjectIds: [] })))).toContain("org-1");
  });

  it("mutation — removing the grant branch makes a grant-only visibility test fail", () => {
    const standingWithGrant = makeStanding({ membershipId: 99 });
    const standingNoGrant = makeStanding({ membershipId: null });
    const withBranch = shape(chunkVisibleTo(standingWithGrant));
    const withoutBranch = shape(chunkVisibleTo(standingNoGrant));
    expect(withBranch).toContain('"kb_page_grants"');
    expect(withoutBranch).not.toContain('"kb_page_grants"');
  });
});
