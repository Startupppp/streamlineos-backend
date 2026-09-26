import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCANNED_DOCUMENT_FIELDS } from "./document-pii-scan";

function readMigration(name: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
}

const MIGRATION_TAG = "1347_kb_hr_documents_guard_scanned_fields";

describe("migration 1347 (unapplied, unjournalled): the forward file's trigger OF clause covers every scanned document metadata field", () => {
  const migration = readMigration(`${MIGRATION_TAG}.sql`);
  const rollback = readMigration(`${MIGRATION_TAG}_rollback.sql`);

  const triggerStatement = (() => {
    const match = migration.match(/CREATE TRIGGER[\s\S]*?EXECUTE FUNCTION[^\n]+\n/);
    return match?.[0] ?? "";
  })();

  it("self-check: migration file contains a CREATE TRIGGER for the unlink guard", () => {
    expect(triggerStatement.length).toBeGreaterThan(0);
    expect(triggerStatement).toContain("trg_documents_unlink_when_unpublishable");
    expect(triggerStatement).toContain("AFTER UPDATE OF");
  });

  it("each field in SCANNED_DOCUMENT_FIELDS appears as a quoted column name in the trigger's OF clause", () => {
    const ofSectionMatch = triggerStatement.match(/AFTER UPDATE OF([\s\S]*?)ON\s+"public"/);
    expect(ofSectionMatch).not.toBeNull();
    const ofSection = ofSectionMatch![1];

    for (const field of SCANNED_DOCUMENT_FIELDS) {
      expect(ofSection).toContain(`"${field}"`);
    }
  });

  it("the OF clause is driven by SCANNED_DOCUMENT_FIELDS — adding a new scanned field fails here, signalling a follow-up migration is needed", () => {
    const ofSectionMatch = triggerStatement.match(/AFTER UPDATE OF([\s\S]*?)ON\s+"public"/);
    expect(ofSectionMatch).not.toBeNull();
    const ofSection = ofSectionMatch![1];

    const columnsInOf = [...ofSection.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);

    for (const field of SCANNED_DOCUMENT_FIELDS) {
      expect(columnsInOf).toContain(field);
    }
  });

  it("the trigger function body checks each scanned field individually via OLD/NEW comparison", () => {
    for (const field of SCANNED_DOCUMENT_FIELDS) {
      expect(migration).toMatch(new RegExp(`OLD\\.${field}\\s+IS DISTINCT FROM NEW\\.${field}`));
    }
  });

  it("the trigger function body concatenates each scanned field into the PII scan text", () => {
    for (const field of SCANNED_DOCUMENT_FIELDS) {
      const isArrayField = field === "tags";
      if (isArrayField) {
        expect(migration).toContain("array_to_string(NEW.tags");
      } else {
        expect(migration).toContain(`NEW.${field}`);
      }
    }
  });

  it("the rollback recreates the trigger without the scanned fields in the OF clause", () => {
    const rollbackTriggerMatch = rollback.match(/CREATE TRIGGER[\s\S]*?EXECUTE FUNCTION[^\n]+\n/);
    expect(rollbackTriggerMatch).not.toBeNull();
    const rollbackTrigger = rollbackTriggerMatch![0];

    const rollbackOfMatch = rollbackTrigger.match(/AFTER UPDATE OF([\s\S]*?)ON\s+"public"/);
    expect(rollbackOfMatch).not.toBeNull();
    const rollbackOf = rollbackOfMatch![1];

    for (const field of SCANNED_DOCUMENT_FIELDS) {
      expect(rollbackOf).not.toContain(`"${field}"`);
    }
  });

  it("the rollback restores the WHEN clause that was removed from the forward migration", () => {
    expect(migration).not.toMatch(/\bWHEN\s*\(app\.hr_document_is_publishable/);
    expect(rollback).toMatch(/WHEN\s*\(app\.hr_document_is_publishable/);
  });
});
