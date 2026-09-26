import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { chunkVisibleTo } from "./kb-chunk-visibility";
import { visibleTo } from "./kb-page-visibility";
import { kbPages } from "../../../db/schema";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

const dialect = new PgDialect();

const shape = (node: SQL<unknown>): string =>
  dialect.sqlToQuery(node).sql.replace(/\s+/g, " ").trim();

const boundParams = (node: SQL<unknown>): unknown[] => dialect.sqlToQuery(node).params;

const pageColumns = {
  orgId: kbPages.orgId,
  visibility: kbPages.visibility,
  projectId: kbPages.projectId,
  createdById: kbPages.createdById,
  createdByMembershipId: kbPages.createdByMembershipId,
};

const COLUMN_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/"kb_article_chunks"\."page_created_by_membership_id"/g, "M"],
  [/"kb_pages"\."created_by_membership_id"/g, "M"],
  [/"kb_article_chunks"\."page_created_by_id"/g, "C"],
  [/"kb_pages"\."created_by_id"/g, "C"],
  [/"kb_article_chunks"\."page_visibility"/g, "V"],
  [/"kb_pages"\."visibility"/g, "V"],
  [/"kb_article_chunks"\."page_project_id"/g, "P"],
  [/"kb_pages"\."project_id"/g, "P"],
  [/"kb_article_chunks"\."org_id"/g, "O"],
  [/"kb_pages"\."org_id"/g, "O"],
];

const normalizeColumns = (rendered: string): string =>
  COLUMN_ALIASES.reduce((acc, [pattern, alias]) => acc.replace(pattern, alias), rendered);

describe("chunkVisibleTo", () => {
  it("reads the chunk's own copy of the page's access facts", () => {
    const built = shape(chunkVisibleTo(makeUser(), [42]));
    expect(built).toContain(`"kb_article_chunks"."page_visibility"`);
    expect(built).toContain(`"kb_article_chunks"."page_project_id"`);
    expect(built).toContain(`"kb_article_chunks"."page_created_by_id"`);
    expect(built).toContain(`"kb_article_chunks"."page_created_by_membership_id"`);
  });

  it("does not read the page table, so retrieval needs no join", () => {
    const built = shape(chunkVisibleTo(makeUser(), [42]));
    expect(built).not.toContain("kb_pages");
    expect(built).not.toMatch(/(?<!page_)visibility(?!\w)/);
  });

  it("is the same rule as the shared builder produces over the page's own columns", () => {
    const asChunk = normalizeColumns(shape(chunkVisibleTo(makeUser(), [42])));
    const asPage = normalizeColumns(shape(visibleTo(pageColumns, makeUser(), [42])));

    expect(asChunk).toBe(asPage);
    expect(asChunk).toContain("V IN ('org', 'public')");
    expect(boundParams(chunkVisibleTo(makeUser(), [42]))).toEqual(
      boundParams(visibleTo(pageColumns, makeUser(), [42])),
    );
  });

  it("the column normalisation is not what makes the two sides match — a different rule still differs", () => {
    const asChunk = normalizeColumns(shape(chunkVisibleTo(makeUser(), [42])));
    const narrower = normalizeColumns(shape(visibleTo(pageColumns, makeUser(), [])));

    expect(asChunk).not.toBe(narrower);
  });

  it("narrows a reader who belongs to no project", () => {
    const built = shape(chunkVisibleTo(makeUser(), []));
    expect(built).toContain(`"kb_article_chunks"."page_project_id" IS NULL`);
    expect(built).not.toContain("ANY(ARRAY");
  });

  it("gives an org owner the whole organisation", () => {
    expect(shape(chunkVisibleTo(makeUser({ isOrgOwner: true }), []))).toContain(
      `"kb_article_chunks"."org_id"`,
    );
  });
});
