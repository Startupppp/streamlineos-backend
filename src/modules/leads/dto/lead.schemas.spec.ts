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
  it("ingestSchema allows all-optional but is validated by route for name|email|phone", () => {
    expect(ingestSchema.parse({})).toEqual({});
    expect(ingestSchema.parse({ email: "x@y.com" }).email).toBe("x@y.com");
  });
  it("updateSchema is all-optional", () => {
    expect(updateSchema.parse({})).toEqual({});
    expect(updateSchema.parse({ priority: "HOT" }).priority).toBe("HOT");
  });
});
