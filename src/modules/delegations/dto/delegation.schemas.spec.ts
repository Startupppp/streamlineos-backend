import { listDelegationsQuerySchema } from "./delegation.schemas";

describe("listDelegationsQuerySchema", () => {
  it("uses production list defaults", () => {
    expect(listDelegationsQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
    });
  });

  it("coerces pagination and trims search", () => {
    expect(
      listDelegationsQuerySchema.parse({
        page: "3",
        limit: "50",
        search: "  quarterly cover  ",
      }),
    ).toEqual({
      page: 3,
      limit: 50,
      search: "quarterly cover",
    });
  });

  it.each([
    { page: "0" },
    { page: "1.5" },
    { limit: "25" },
    { limit: "100" },
    { search: "x".repeat(101) },
    { unexpected: "value" },
  ])("rejects invalid list input %#", (input) => {
    expect(listDelegationsQuerySchema.safeParse(input).success).toBe(false);
  });
});
