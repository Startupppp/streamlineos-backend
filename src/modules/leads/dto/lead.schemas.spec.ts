import { listSchema, createSchema, updateSchema, ingestSchema } from "./lead.schemas";

describe("lead schemas", () => {
  it("listSchema coerces page/limit and enforces limit<=100", () => {
    expect(listSchema.parse({ page: "2", limit: "50" })).toMatchObject({ page: 2, limit: 50 });
    expect(listSchema.parse({ limit: "500" }).limit).toBe(100);
  });
  it("createSchema requires name and defaults source/priority", () => {
    expect(createSchema.parse({ name: "Acme" })).toMatchObject({ name: "Acme", source: "other", priority: "WARM" });
    expect(() => createSchema.parse({})).toThrow();
  });
  it("createSchema accepts empty-string email", () => {
    expect(createSchema.parse({ name: "A", email: "" }).email).toBe("");
  });
  it("ingestSchema requires at least one of name, email, or phone", () => {
    expect(() => ingestSchema.parse({})).toThrow("At least one of name, email, or phone is required");
    expect(ingestSchema.parse({ email: "x@y.com" }).email).toBe("x@y.com");
    expect(ingestSchema.parse({ name: "Acme" }).name).toBe("Acme");
    expect(ingestSchema.parse({ phone: "555" }).phone).toBe("555");
  });
  it("updateSchema is all-optional", () => {
    expect(updateSchema.parse({})).toEqual({});
    expect(updateSchema.parse({ priority: "HOT" }).priority).toBe("HOT");
  });
});
