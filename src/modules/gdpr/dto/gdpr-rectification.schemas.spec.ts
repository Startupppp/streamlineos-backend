import { gdprRectificationBodySchema } from "./gdpr-rectification.schemas";

describe("gdprRectificationBodySchema", () => {
  it("accepts a normalized self-service profile-name correction", () => {
    expect(
      gdprRectificationBodySchema.parse({ field: "profile.name", value: "  Ananya Rao  " }),
    ).toEqual({ field: "profile.name", value: "Ananya Rao" });
  });

  it("rejects unsupported fields and empty values", () => {
    expect(
      gdprRectificationBodySchema.safeParse({ field: "profile.email", value: "person@example.com" }).success,
    ).toBe(false);
    expect(
      gdprRectificationBodySchema.safeParse({ field: "profile.name", value: "   " }).success,
    ).toBe(false);
  });
});
