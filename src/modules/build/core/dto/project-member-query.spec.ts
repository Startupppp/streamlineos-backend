import { listProjectMembersQuerySchema } from "./project-core.schemas";

describe("listProjectMembersQuerySchema", () => {
  it("trims q and exposes it as the canonical search term", () => {
    expect(
      listProjectMembersQuerySchema.parse({ q: "  Alice Smith  " }),
    ).toEqual({ limit: 25, search: "Alice Smith" });
  });

  it("accepts search directly and normalizes blank input to no filter", () => {
    expect(
      listProjectMembersQuerySchema.parse({ search: "  alice@example.com  " }),
    ).toEqual({ limit: 25, search: "alice@example.com" });
    expect(listProjectMembersQuerySchema.parse({ search: "   " })).toEqual({
      limit: 25,
    });
  });

  it("uses search when both aliases are supplied", () => {
    expect(
      listProjectMembersQuerySchema.parse({ q: "old", search: "new" }),
    ).toEqual({ limit: 25, search: "new" });
  });

  it("rejects terms over the bounded search length", () => {
    expect(
      listProjectMembersQuerySchema.safeParse({ q: "x".repeat(201) }).success,
    ).toBe(false);
    expect(
      listProjectMembersQuerySchema.safeParse({ search: "x".repeat(201) })
        .success,
    ).toBe(false);
  });
});
