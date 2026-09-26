import {
  createGitConnectionSchema,
  gitConnectionsListSchema,
  updateGitConnectionSchema,
} from "./git-connections.schemas";

/**
 * Moved here with the routes they validate. A bare `z.object({})` strips an
 * unknown key silently, which turns a dropped or misspelt field into a
 * wrong-subject write rather than a 400 — so strictness is asserted, not
 * assumed, wherever these schemas live.
 */
describe("git connection request schemas reject unknown keys", () => {
  it.each([
    [
      "createGitConnectionSchema",
      createGitConnectionSchema,
      { provider: "github", repoUrl: "https://example.com/a/b" },
    ],
    ["updateGitConnectionSchema", updateGitConnectionSchema, { isActive: true }],
    ["gitConnectionsListSchema", gitConnectionsListSchema, { limit: 10 }],
  ])("%s accepts its declared body and refuses an extra field", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
    expect(schema.safeParse({ ...body, orgId: "org-2" }).success).toBe(false);
  });
});

describe("the list query is bounded", () => {
  it("clamps an over-large page to the platform cap rather than refusing it", () => {
    const parsed = gitConnectionsListSchema.parse({ limit: 5000 });
    expect(parsed.limit).toBe(100);
  });

  it("defaults to a page size when none is asked for", () => {
    expect(gitConnectionsListSchema.parse({}).limit).toBe(50);
  });
});

describe("gitConnectionsListSchema search field", () => {
  it("accepts a search string", () => {
    expect(gitConnectionsListSchema.safeParse({ search: "acme" }).success).toBe(true);
  });

  it("treats the search field as optional — omitting it is valid", () => {
    const result = gitConnectionsListSchema.parse({});
    expect(result.search).toBeUndefined();
  });

  it("rejects unknown keys even when search is present", () => {
    expect(
      gitConnectionsListSchema.safeParse({ search: "acme", unknownKey: true }).success,
    ).toBe(false);
  });
});
