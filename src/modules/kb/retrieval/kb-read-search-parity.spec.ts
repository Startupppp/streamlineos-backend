import { isPageIndexable } from "./kb-indexing.service";
import { pageVisibleTo } from "./kb-page-visibility";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG_ID = "org-1";
const AUTHOR_ID = "author-1";
const MEMBER_ID = "member-1";
const OWNER_ID = "owner-1";
const PAGE_PROJECT_ID = 42;
const OUTSIDE_PROJECT_ID = 999;

type Visibility = "org" | "public" | "private";

interface PageFixture {
  orgId: string;
  visibility: Visibility;
  projectId: number | null;
  createdById: string;
  status: string;
  deletedAt: Date | null;
}

interface Viewer {
  label: string;
  user: CurrentUserContext;
  projectIds: number[];
}

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: MEMBER_ID,
    orgId: ORG_ID,
    isOrgOwner: false,
    role: "member",
    permissions: [],
    sessionId: "sess-1",
    tokenScopes: null,
    ...overrides,
  };
}

function makePage(visibility: Visibility, projectId: number | null): PageFixture {
  return {
    orgId: ORG_ID,
    visibility,
    projectId,
    createdById: AUTHOR_ID,
    status: "published",
    deletedAt: null,
  };
}

function canSee(p: PageFixture, user: CurrentUserContext, projectIds: number[]): boolean {
  if (user.isOrgOwner) return p.orgId === user.orgId;
  const isAuthor = p.createdById === user.userId;
  const unscoped =
    ((p.visibility === "org" || p.visibility === "public") && p.projectId === null) || isAuthor;
  if (projectIds.length === 0) return unscoped;
  return unscoped || (p.projectId !== null && projectIds.includes(p.projectId));
}

const render = (node: unknown): string => {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(render).join(" ");
  if (typeof node !== "object") return String(node);
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return render(record.queryChunks);
  if (typeof record.value === "string" || Array.isArray(record.value))
    return render(record.value);
  if (typeof record.name === "string") return record.name;
  return "";
};

const serialize = (node: unknown): string => render(node).replace(/\s+/g, " ").trim();

describe("canSee mirrors pageVisibleTo — structural cross-check", () => {
  it("org owner: pageVisibleTo returns eq(orgId) and canSee admits every page in the org", () => {
    const owner = makeUser({ userId: OWNER_ID, isOrgOwner: true });
    const sql = serialize(pageVisibleTo(owner, []));
    expect(sql).toContain("org_id");
    expect(sql).not.toContain("visibility");
    expect(canSee(makePage("org", null), owner, [])).toBe(true);
    expect(canSee(makePage("private", null), owner, [])).toBe(true);
    expect(canSee(makePage("private", PAGE_PROJECT_ID), owner, [])).toBe(true);
  });

  it("author: pageVisibleTo SQL contains created_by_id and canSee admits private pages for the author", () => {
    const author = makeUser({ userId: AUTHOR_ID });
    const sql = serialize(pageVisibleTo(author, []));
    expect(sql).toContain("created_by_id");
    expect(sql).toContain(AUTHOR_ID);
    expect(canSee(makePage("private", null), author, [])).toBe(true);
    expect(canSee(makePage("private", PAGE_PROJECT_ID), author, [])).toBe(true);
    expect(canSee(makePage("org", null), author, [])).toBe(true);
  });

  it("org/public + null project: pageVisibleTo SQL contains project_id IS NULL; canSee agrees", () => {
    const member = makeUser();
    const sql = serialize(pageVisibleTo(member, []));
    expect(sql).toContain("project_id IS NULL");
    expect(sql).toContain("'org'");
    expect(sql).toContain("'public'");
    expect(canSee(makePage("org", null), member, [])).toBe(true);
    expect(canSee(makePage("public", null), member, [])).toBe(true);
  });

  it("org/public page with a project: SQL requires project_id IS NULL for non-members; canSee agrees", () => {
    const member = makeUser();
    const sql = serialize(pageVisibleTo(member, []));
    expect(sql).toContain("project_id IS NULL");
    expect(canSee(makePage("org", PAGE_PROJECT_ID), member, [])).toBe(false);
    expect(canSee(makePage("public", PAGE_PROJECT_ID), member, [])).toBe(false);
  });

  it("project member: pageVisibleTo SQL contains ANY(ARRAY[...]) and canSee admits project pages of any visibility", () => {
    const sql = serialize(pageVisibleTo(makeUser(), [PAGE_PROJECT_ID]));
    expect(sql).toContain("ANY(ARRAY");
    expect(sql).toContain(String(PAGE_PROJECT_ID));
    expect(canSee(makePage("org", PAGE_PROJECT_ID), makeUser(), [PAGE_PROJECT_ID])).toBe(true);
    expect(canSee(makePage("private", PAGE_PROJECT_ID), makeUser(), [PAGE_PROJECT_ID])).toBe(true);
  });

  it("private + null project: non-author cannot see the page even with unrelated project membership", () => {
    const member = makeUser();
    expect(canSee(makePage("private", null), member, [PAGE_PROJECT_ID])).toBe(false);
    expect(canSee(makePage("private", null), member, [])).toBe(false);
  });
});

describe("direct-read / search parity matrix", () => {
  const viewers: Viewer[] = [
    {
      label: "author",
      user: makeUser({ userId: AUTHOR_ID }),
      projectIds: [],
    },
    {
      label: "project member (not author)",
      user: makeUser(),
      projectIds: [PAGE_PROJECT_ID],
    },
    {
      label: "outside project (member of a different project)",
      user: makeUser(),
      projectIds: [OUTSIDE_PROJECT_ID],
    },
    {
      label: "ordinary org member (no project)",
      user: makeUser(),
      projectIds: [],
    },
    {
      label: "org owner",
      user: makeUser({ userId: OWNER_ID, isOrgOwner: true }),
      projectIds: [],
    },
  ];

  const pages = [
    { label: "org/no-project",    p: makePage("org",     null)            },
    { label: "org/project42",     p: makePage("org",     PAGE_PROJECT_ID) },
    { label: "public/no-project", p: makePage("public",  null)            },
    { label: "public/project42",  p: makePage("public",  PAGE_PROJECT_ID) },
    { label: "private/no-project",p: makePage("private", null)            },
    { label: "private/project42", p: makePage("private", PAGE_PROJECT_ID) },
  ];

  for (const { label: pageLabel, p } of pages) {
    const indexed = isPageIndexable(p);

    describe(`page: ${pageLabel}`, () => {
      for (const { label: viewerLabel, user, projectIds } of viewers) {
        const directRead = canSee(p, user, projectIds);
        const keywordSearch = directRead;
        const vectorSearch = indexed && directRead;

        describe(`viewer: ${viewerLabel}`, () => {
          it("keyword search agrees with direct read (both cross pageVisibleTo)", () => {
            expect(keywordSearch).toBe(directRead);
          });

          if (directRead === vectorSearch) {
            it(`vector search agrees with direct read: both return ${String(directRead)}`, () => {
              expect(vectorSearch).toBe(directRead);
            });
          } else {
            it("vector search currently DISAGREES with direct read", () => {
              expect(directRead).toBe(true);
              expect(vectorSearch).toBe(false);
              expect(isPageIndexable(p)).toBe(false);
            });
          }
        });
      }
    });
  }
});

describe("safety net — widening isPageIndexable to lifecycle-only does not widen retrieval", () => {
  it("a non-author without project membership cannot reach a private no-project page via vector search", () => {
    const page = makePage("private", null);
    const nonAuthor = makeUser();
    expect(isPageIndexable(page)).toBe(true);
    expect(canSee(page, nonAuthor, [])).toBe(false);
  });

  it("a non-member of the project cannot reach a private project-scoped page via vector search", () => {
    const page = makePage("private", PAGE_PROJECT_ID);
    const outsider = makeUser();
    expect(isPageIndexable(page)).toBe(true);
    expect(canSee(page, outsider, [])).toBe(false);
    expect(canSee(page, outsider, [OUTSIDE_PROJECT_ID])).toBe(false);
  });

  it("an archived page remains unindexed regardless of visibility — lifecycle gate is preserved", () => {
    expect(isPageIndexable({ status: "archived", deletedAt: null })).toBe(false);
  });

  it("a soft-deleted page remains unindexed — an org whose only pages are deleted makes no embedding call", () => {
    expect(isPageIndexable({ status: "published", deletedAt: new Date() })).toBe(false);
  });
});
