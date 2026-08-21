import { orgDuplicateCheckSchema } from "./org-merge.schemas";

describe("orgDuplicateCheckSchema", () => {
  it("accepts a name-only check", () => {
    expect(orgDuplicateCheckSchema.parse({ name: "Acme" }).name).toBe("Acme");
  });

  it("accepts a domain-only check", () => {
    expect(orgDuplicateCheckSchema.parse({ domain: "acme.com" }).domain).toBe("acme.com");
  });

  it("rejects an empty check, which would otherwise match every organization", () => {
    expect(() => orgDuplicateCheckSchema.parse({})).toThrow();
  });

  it("rejects a blank-only name rather than treating it as a discriminator", () => {
    expect(() => orgDuplicateCheckSchema.parse({ name: "   " })).toThrow();
  });

  it("rejects unknown keys so a caller cannot smuggle a filter", () => {
    expect(() =>
      orgDuplicateCheckSchema.parse({ name: "Acme", orgId: "other-tenant" }),
    ).toThrow();
  });

  it("trims, so a padded name still matches the stored value", () => {
    expect(orgDuplicateCheckSchema.parse({ name: "  Acme  " }).name).toBe("Acme");
  });
});
