import { listSchema, searchSchema, createSchema, updateSchema } from "./contact.schemas";

describe("contact schemas", () => {
  it("listSchema coerces organizationId/limit/offset and enforces limit<=100", () => {
    expect(listSchema.parse({ organizationId: "5", limit: "50", offset: "10" })).toMatchObject({
      organizationId: 5,
      limit: 50,
      offset: 10,
    });
    expect(() => listSchema.parse({ limit: "500" })).toThrow();
  });

  it("searchSchema requires q of at least 2 characters", () => {
    expect(searchSchema.parse({ q: "ab" }).q).toBe("ab");
    expect(() => searchSchema.parse({ q: "a" })).toThrow();
    expect(() => searchSchema.parse({})).toThrow();
  });

  it("createSchema requires name and defaults tags to []", () => {
    expect(createSchema.parse({ name: "Jane" })).toMatchObject({ name: "Jane", tags: [] });
    expect(() => createSchema.parse({})).toThrow();
  });

  it("createSchema accepts empty-string email", () => {
    expect(createSchema.parse({ name: "Ana", email: "" }).email).toBe("");
  });

  it("createSchema rejects a name that is not a name", () => {
    expect(() => createSchema.parse({ name: "(*&(&TGISBFd Df" })).toThrow();
    expect(() => createSchema.parse({ name: "A" })).toThrow();
    expect(() => createSchema.parse({ name: "   " })).toThrow();
    expect(createSchema.parse({ name: "  Mary-Jane O'Brien  " }).name).toBe(
      "Mary-Jane O'Brien",
    );
  });

  it("updateSchema is all-optional and allows nullable fields", () => {
    expect(updateSchema.parse({})).toEqual({});
    expect(updateSchema.parse({ email: null, leadId: null }).email).toBeNull();
  });
});
