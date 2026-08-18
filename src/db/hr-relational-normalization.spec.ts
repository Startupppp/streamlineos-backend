import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundleRoot = "migrations/pending/hrms-relational-normalization";

function readBundleFile(bundleFileName: string): string {
  return readFileSync(resolve(process.cwd(), bundleRoot, bundleFileName), "utf8");
}

describe("HRMS relational normalization review bundle", () => {
  const forwardMigration = readBundleFile("0000_hrms_relational_normalization.sql");
  const backfillMigration = readBundleFile(
    "0001_hrms_relational_normalization_backfill.sql",
  );
  const rollbackMigration = readBundleFile(
    "0000_hrms_relational_normalization.down.sql",
  );
  const verification = readBundleFile("verify.sql");

  it("creates all six tenant-scoped child or link tables", () => {
    expect(forwardMigration.match(/CREATE TABLE /g)).toHaveLength(6);
    for (const relationName of [
      "hr_employee_sensitive_disciplinary_records",
      "hr_employee_sensitive_grievance_records",
      "hr_document_tags",
      "onboarding_task_dependencies",
      "termination_reasons",
      "termination_supporting_documents",
    ]) {
      expect(forwardMigration).toContain(`CREATE TABLE ${relationName}`);
      expect(forwardMigration).toContain(
        `ALTER TABLE ${relationName} ENABLE ROW LEVEL SECURITY`,
      );
    }
  });

  it("stages and validates every organization or composite parent foreign key", () => {
    expect(forwardMigration.match(/ON DELETE (?:CASCADE|RESTRICT) NOT VALID;/g)).toHaveLength(
      13,
    );
    expect(forwardMigration.match(/VALIDATE CONSTRAINT /g)).toHaveLength(13);
    expect(forwardMigration).toContain(
      "FOREIGN KEY (organization_id, prerequisite_task_id)",
    );
    expect(forwardMigration).toContain(
      "CHECK (onboarding_task_id <> prerequisite_task_id AND sort_order >= 0)",
    );
  });

  it("uses descriptive durable identity names and preserves ordered uniqueness", () => {
    for (const identityColumn of [
      "disciplinary_record_id",
      "grievance_record_id",
      "document_tag_id",
      "onboarding_task_dependency_id",
      "termination_reason_id",
      "termination_supporting_document_id",
    ])
      expect(forwardMigration).toContain(`${identityColumn} bigint GENERATED ALWAYS AS IDENTITY`);
    expect(forwardMigration).not.toMatch(/^\s*id\s+/m);
    expect(forwardMigration).toContain("uniq_hr_document_tags_parent_order");
    expect(forwardMigration).toContain("uniq_termination_reasons_parent_order");
  });

  it("backfills deterministically without mutating or removing legacy columns", () => {
    expect(backfillMigration.match(/WITH ORDINALITY/g)).toHaveLength(6);
    expect(backfillMigration.match(/ON CONFLICT/g)).toHaveLength(6);
    expect(backfillMigration).toContain("SET TIME ZONE 'UTC'");
    expect(backfillMigration).not.toMatch(/ALTER TABLE|DROP COLUMN|UPDATE documents|UPDATE terminations/);
    expect(forwardMigration).not.toMatch(/DROP COLUMN/);
  });

  it("makes rollback refuse drift and leaves every legacy column intact", () => {
    expect(rollbackMigration).toContain(
      "HR_RELATIONAL_NORMALIZATION_ROLLBACK_DRIFT",
    );
    expect(rollbackMigration.match(/DROP TABLE /g)).toHaveLength(6);
    expect(rollbackMigration).not.toMatch(/DROP COLUMN|UPDATE /);
  });

  it("fails verification for every unreconciled legacy collection", () => {
    for (const mismatchCode of [
      "DISCIPLINARY_MISMATCH",
      "GRIEVANCE_MISMATCH",
      "DOCUMENT_TAG_MISMATCH",
      "ONBOARDING_DEPENDENCY_MISMATCH",
      "TERMINATION_REASON_MISMATCH",
      "SUPPORTING_DOCUMENT_MISMATCH",
    ])
      expect(verification).toContain(
        `HR_RELATIONAL_NORMALIZATION_${mismatchCode}`,
      );
  });

  it("keeps supporting-document URLs as legacy compatibility metadata only", () => {
    expect(forwardMigration).toContain("legacy_url text NOT NULL");
    expect(forwardMigration).not.toMatch(/public_url|storage_key|bucket|object_key/);
  });
});
