import { chunkVisibleTo } from "./kb-chunk-visibility";
import { pageVisibleTo } from "./kb-page-visibility";
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

const shape = (value: unknown): string => render(value).replace(/\s+/g, " ").trim();

describe("chunkVisibleTo", () => {
  it("reads the chunk's own copy of the page's access facts", () => {
    const built = shape(chunkVisibleTo(makeUser(), [42]));
    expect(built).toContain("page_visibility");
    expect(built).toContain("page_project_id");
    expect(built).toContain("page_created_by_id");
    expect(built).toContain("page_created_by_membership_id");
  });

  it("does not read the page table, so retrieval needs no join", () => {
    const built = shape(chunkVisibleTo(makeUser(), [42]));
    expect(built).not.toContain("kb_pages");
    expect(built).not.toMatch(/(?<!page_)visibility(?!\w)/);
  });

  it("is the same rule as the page predicate, only over different columns", () => {
    const asChunk = shape(chunkVisibleTo(makeUser(), [42]))
      .replace(/page_created_by_membership_id/g, "M")
      .replace(/page_visibility/g, "V")
      .replace(/page_project_id/g, "P")
      .replace(/page_created_by_id/g, "C");
    const asPage = shape(pageVisibleTo(makeUser(), [42]))
      .replace(/created_by_membership_id/g, "M")
      .replace(/visibility/g, "V")
      .replace(/project_id/g, "P")
      .replace(/created_by_id/g, "C");
    expect(asChunk).toBe(asPage);
  });

  it("narrows a reader who belongs to no project", () => {
    const built = shape(chunkVisibleTo(makeUser(), []));
    expect(built).toContain("page_project_id IS NULL");
    expect(built).not.toContain("ANY(ARRAY");
  });

  it("gives an org owner the whole organisation", () => {
    expect(shape(chunkVisibleTo(makeUser({ isOrgOwner: true }), []))).toContain("org_id");
  });
});
