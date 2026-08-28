import { listRolesQuerySchema } from "./rbac.schemas";

describe("listRolesQuerySchema", () => {
  it("uses production pagination defaults", () => {
    expect(listRolesQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
    });
  });

  it.each([10, 20, 50, 100])("accepts and coerces the supported limit %i", (limit) => {
    expect(
      listRolesQuerySchema.parse({
        page: "2",
        limit: String(limit),
        search: "  manager  ",
      }),
    ).toEqual({
      page: 2,
      limit,
      search: "manager",
    });
  });

  it.each([
    { page: "0" },
    { page: "1.5" },
    { limit: "0" },
    { search: "x".repeat(101) },
    { unexpected: "value" },
  ])("rejects invalid list input %#", (input) => {
    expect(listRolesQuerySchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["25", 25],
    ["100", 100],
    ["101", 100],
  ])("accepts any page size up to the platform cap and clamps above it: %s", (input, expected) => {
    expect(listRolesQuerySchema.parse({ limit: input }).limit).toBe(expected);
  });
});
