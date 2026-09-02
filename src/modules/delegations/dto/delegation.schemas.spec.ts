import { listDelegationsQuerySchema } from "./delegation.schemas";

describe("listDelegationsQuerySchema", () => {
  it("uses production list defaults", () => {
    expect(listDelegationsQuerySchema.parse({})).toEqual({
      limit: 20,
    });
  });

  it("coerces the page size, keeps the cursor and trims search", () => {
    expect(
      listDelegationsQuerySchema.parse({
        cursor: "eyJpZCI6IjEifQ==",
        limit: "50",
        search: "  quarterly cover  ",
      }),
    ).toEqual({
      cursor: "eyJpZCI6IjEifQ==",
      limit: 50,
      search: "quarterly cover",
    });
  });

  it.each([
    { limit: "0" },
    { limit: "1.5" },
    { search: "x".repeat(101) },
    { cursor: 1 },
    { page: "1" },
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
