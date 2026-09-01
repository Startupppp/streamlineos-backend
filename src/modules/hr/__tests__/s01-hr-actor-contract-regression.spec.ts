import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DocumentsService } from "../performance/documents.service";
import { AuditService } from "../../../common/audit/audit.service";

const MIGRATION_ROOT = resolve(process.cwd(), "migrations");

function readMigration(name: string): string {
  return readFileSync(resolve(MIGRATION_ROOT, name), "utf8");
}

function documentListDb() {
  return {
    select: jest.fn(),
    query: { documents: { findMany: jest.fn() } },
    execute: jest.fn(),
  };
}

describe("S01 HR actor-contract negative regressions", () => {
  const contractMigration = readMigration("0924_s01_hr_remaining_actor_contract.sql");

  it("rejects an account-only actor before an own-scope HR document query", async () => {
    const db = documentListDb();
    const service = new DocumentsService(
      db as never,
      { logCritical: jest.fn() } as unknown as AuditService,
    );

    await expect(service.listDocuments(
      "org-a",
      "account-only-user",
      "own",
      { limit: 20, cursor: undefined, userId: undefined, type: undefined, category: undefined, search: undefined },
      null,
    )).rejects.toThrow("Organization membership required.");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does not map a cross-organization membership during the backfill", () => {
    expect(contractMigration).toContain("member.org_id = source.org_id");
    expect(contractMigration).toContain("member.user_id = source.%I");
    expect(contractMigration).toContain(
      "FOREIGN KEY (org_id, %I)\n       REFERENCES organization_members (org_id, id)",
    );
  });

  it("makes membership removal clear every contracted HR actor pointer", () => {
    expect(contractMigration).toContain(
      "ON DELETE SET NULL (%I) NOT VALID",
    );
    expect(contractMigration).not.toContain("ON DELETE RESTRICT");
  });

  it("cannot select an arbitrary membership when a user has duplicate org membership rows", () => {
    const membershipSchema = readFileSync(
      resolve(process.cwd(), "src/db/schema/common/auth.ts"),
      "utf8",
    );

    expect(membershipSchema).toContain(
      'unique("uniq_org_members_org_user").on(table.orgId, table.userId)',
    );
    expect(contractMigration).toContain("member.org_id = source.org_id");
    expect(contractMigration).toContain("member.user_id = source.%I");
    expect(contractMigration).not.toMatch(/member\.user_id\s*=\s*source\.%I[\s\S]{0,80}LIMIT\s+1/i);
  });

  it("aborts rather than backfilling an unmappable legacy actor", () => {
    expect(contractMigration).toContain(
      "SELECT count(*) FROM %I WHERE %I IS NOT NULL AND %I IS NULL",
    );
    expect(contractMigration).toContain("IF unmappable_count > 0 THEN");
    expect(contractMigration).toContain(
      "has % actor row(s) not mappable in its own organization",
    );
  });
});
