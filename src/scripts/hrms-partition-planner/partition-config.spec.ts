import {
  partitionFamilies,
  partitionSecurityProfileSchema,
} from "./partition-config";

describe("HRMS partition control registry", () => {
  it("defines the approved attendance correction-link controls", () => {
    expect(
      partitionFamilies.attendance_correction_links.leafTriggers.map(
        (recipe) => recipe.name,
      ),
    ).toEqual([
      "reject_attendance_correction_link_mutation",
      "reject_hrms_truncate",
      "verify_attendance_correction_link",
    ]);
  });

  it("defines reciprocal audit controls", () => {
    const eventFamily = partitionFamilies.hr_audit_events;
    const sourceFamily = partitionFamilies.hr_audit_event_sources;
    expect(eventFamily.leafTriggers.map((recipe) => recipe.name)).toEqual([
      "reject_hr_audit_event_mutation",
      "reject_hrms_truncate",
      "verify_hr_audit_source_fact",
    ]);
    expect(sourceFamily.leafTriggers.map((recipe) => recipe.name)).toEqual([
      "reject_hr_audit_event_source_mutation",
      "reject_hrms_truncate",
      "verify_hr_audit_source_fact",
    ]);
  });

  it("accepts only the approved base security profile", () => {
    expect(partitionSecurityProfileSchema.parse("base-owner-only-v1"))
      .toBe("base-owner-only-v1");
    expect(() => partitionSecurityProfileSchema.parse("runtime-append-v1"))
      .toThrow();
  });
});
