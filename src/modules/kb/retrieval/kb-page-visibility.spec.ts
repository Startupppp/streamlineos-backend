import { eq } from "drizzle-orm";
import { pageVisibleTo } from "./kb-page-visibility";
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

const predicate = (user: CurrentUserContext, projectIds: number[]): string =>
  render(pageVisibleTo(user, projectIds)).replace(/\s+/g, " ").trim();

describe("pageVisibleTo", () => {
  it("returns same condition as eq(orgId) for org owner", () => {
    const user = makeUser({ isOrgOwner: true });
    const result = pageVisibleTo(user, []);
    const expected = eq(kbPages.orgId, user.orgId);
    expect(result).toStrictEqual(expected);
  });

  it("returns a different (SQL) condition for regular user", () => {
    const result = pageVisibleTo(makeUser(), []);
    const ownerResult = pageVisibleTo(makeUser({ isOrgOwner: true }), []);
    expect(result).toBeDefined();
    expect(result).not.toStrictEqual(ownerResult);
  });

  describe("a reader who belongs to no project", () => {
    it("is offered only pages that belong to no project", () => {
      expect(predicate(makeUser(), [])).toContain("project_id IS NULL");
    });

    it("is offered no page that belongs to a project", () => {
      const built = predicate(makeUser(), []);
      expect(built).not.toContain("ANY(ARRAY");
      expect(built).not.toContain("<> 'private'");
      expect(built).toContain("project_id IS NULL");
    });

    it("is still offered a public page that belongs to no project", () => {
      expect(predicate(makeUser(), [])).toContain("'public'");
    });
  });

  describe("a reader who belongs to projects", () => {
    it("is offered the pages of the projects they belong to", () => {
      expect(predicate(makeUser(), [42, 43])).toContain("ANY(ARRAY[ 42 , 43 ]::int[])");
    });

    it("is still offered pages that belong to no project", () => {
      expect(predicate(makeUser(), [42])).toContain("project_id IS NULL");
    });

    it("is still offered a public page that belongs to no project", () => {
      expect(predicate(makeUser(), [42])).toContain("'public'");
    });
  });

  it("offers a reader their own page whatever project it belongs to", () => {
    expect(predicate(makeUser(), [])).toContain("created_by_id");
    expect(predicate(makeUser(), [42])).toContain("created_by_id");
  });

  describe("project 42 membership grants access to 42, not to 43", () => {
    it("is offered project 42 pages when member of project 42", () => {
      expect(predicate(makeUser(), [42])).toContain("42");
    });

    it("is not offered project 43 pages when member of only project 42", () => {
      expect(predicate(makeUser(), [42])).not.toContain("43");
    });
  });
});
