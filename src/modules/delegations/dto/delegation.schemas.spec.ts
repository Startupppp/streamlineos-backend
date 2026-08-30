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
    { limit: "0" },
    { search: "x".repeat(101) },
    { unexpected: "value" },
  ])("rejects invalid list input %#", (input) => {
    expect(listDelegationsQuerySchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["25", 25],
    ["100", 100],
    ["101", 100],
  ])("accepts any page size up to the platform cap and clamps above it: %s", (input, expected) => {
    expect(listDelegationsQuerySchema.parse({ limit: input }).limit).toBe(expected);
  });
});
