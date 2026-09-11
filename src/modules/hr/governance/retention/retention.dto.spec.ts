import { createDataRequestSchema, listDataRequestsSchema } from "./retention.dto";

describe("GDPR correction request contract", () => {
  it("accepts a correction request with a field/value description", () => {
    expect(
      createDataRequestSchema.safeParse({
        subjectUserId: "user-1",
        type: "correction",
        reason: "Correct legal name to Ananya Rao",
      }).success,
    ).toBe(true);
  });

  it("rejects a correction request without actionable details", () => {
    expect(
      createDataRequestSchema.safeParse({
        subjectUserId: "user-1",
        type: "correction",
      }).success,
    ).toBe(false);
  });

  it("allows correction requests in the tenant-scoped list filter", () => {
    expect(listDataRequestsSchema.parse({ type: "correction", limit: 20 })).toMatchObject({
      type: "correction",
    });
  });
});
