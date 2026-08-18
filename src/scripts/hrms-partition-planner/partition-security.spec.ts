import {
  assertRelationSecurityRow,
  supportsMaintainPrivilege,
  type RelationSecurityRow,
} from "./partition-security";

const safeRow: RelationSecurityRow = {
  owner_name: "schema_owner",
  current_role: "schema_owner",
  row_security: true,
  force_row_security: false,
  tenant_policy_valid: true,
  column_grants_exist: false,
  public_access_denied: true,
  app_role_exists: true,
  application_access_denied: true,
  acl_matches_owner_default: true,
  sequence_access_valid: true,
};

describe("partition relation security gate", () => {
  it("accepts the exact owner-only posture", () => {
    expect(() =>
      assertRelationSecurityRow(
        "attendance_events",
        safeRow,
        true,
        "base-owner-only-v1",
      ),
    ).not.toThrow();
  });

  it.each([
    ["public_access_denied", false],
    ["application_access_denied", false],
    ["acl_matches_owner_default", false],
    ["sequence_access_valid", false],
  ])("rejects a drifted %s gate", (field, value) => {
    const row = { ...safeRow, [field]: value };
    expect(() =>
      assertRelationSecurityRow(
        "attendance_events",
        row,
        true,
        "base-owner-only-v1",
      ),
    ).toThrow();
  });

  it("rejects a non-owner execution role", () => {
    expect(() =>
      assertRelationSecurityRow(
        "attendance_events",
        { ...safeRow, current_role: "operator" },
        true,
        "base-owner-only-v1",
      ),
    ).toThrow("SET ROLE");
  });

  it("uses the PG17 boundary before querying MAINTAIN", () => {
    expect(supportsMaintainPrivilege(160999)).toBe(false);
    expect(supportsMaintainPrivilege(170000)).toBe(true);
  });
});
