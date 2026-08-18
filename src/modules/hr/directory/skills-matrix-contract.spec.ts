import { skillsMatrixQuerySchema } from "./dto/hr-directory.schemas";

describe("skills matrix list contract", () => {
  it("uses a bounded default cursor page", () => {
    expect(skillsMatrixQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(
      skillsMatrixQuerySchema.parse({ cursor: "next-page", limit: "50" }),
    ).toEqual({ cursor: "next-page", limit: 50 });
  });

  it("rejects oversized pages and unrelated query fields", () => {
    expect(() => skillsMatrixQuerySchema.parse({ limit: 51 })).toThrow();
    expect(() =>
      skillsMatrixQuerySchema.parse({ limit: 20, organizationId: "other-org" }),
    ).toThrow();
  });
});
