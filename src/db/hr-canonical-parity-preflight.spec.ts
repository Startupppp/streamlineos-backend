import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("HR canonical parity preflight", () => {
  const sql = readFileSync(
    resolve(
      process.cwd(),
      "..",
      "docs",
      "schema-migration",
      "hr-users-canonical-parity-preflight.sql",
    ),
    "utf8",
  );

  it("is read-only", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/gim);
  });

  it("checks tenant-correlated canonical structure and sensitive parity", () => {
    expect(sql).toContain("hp.org_id = om.org_id");
    expect(sql).toContain("he.org_id = om.org_id");
    expect(sql).toContain("sf.org_id = om.org_id");
    expect(sql).toContain("primary_employment_count > 1");
    expect(sql).toContain("round(monthly_salary * 100)");
    expect(sql).toContain("tax_id_mismatches");
  });

  it("does not guess ambiguous mappings", () => {
    expect(sql).toContain("legacy_bank_details_rows");
    expect(sql).toContain("legacy_reporting_rows");
    expect(sql).toContain("legacy_branch_rows");
  });
});
