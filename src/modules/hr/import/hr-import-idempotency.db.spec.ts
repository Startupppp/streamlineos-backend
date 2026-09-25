/**
 * HRMS-E2E-006 and -007, against a real Postgres.
 *
 * QA imported a four-row asset sheet, got four assets, imported the same sheet
 * again and got eight — with serial QA-SN-0001 present six times. The document
 * sheet behaved the same way: three rows became six. Both commit paths inserted
 * unconditionally, and neither table carries a unique index that could have
 * stopped it, so the second import was indistinguishable from a first.
 *
 * Mocks cannot show this. The defect is that the SQL issued was an INSERT with
 * nothing to conflict against, so the evidence has to be row counts in a real
 * table. These assertions fail if the identity lookups in `commitAsset` and
 * `commitDocumentRow` are removed.
 *
 * Run with:
 *   DATABASE_URL=postgres://…/streamline_hrms_e2e ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     pnpm test:db-specs --testPathPattern="hr-import-idempotency"
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { HrImportCommitService } from "./hr-import-commit.service";
import { importContext, stubAdmission, stubPersonEmployment } from "./import-commit-test-harness";
import type { CommitOutcome } from "./hr-import-commit.service";

const describeDb = dbSpecSuite();

const ASSET_SHEET = [
  { name: "QA Laptop A", type: "LAPTOP", brand: "Dell", model: "Latitude 5440", serialNumber: "QA-SN-0001" },
  { name: "QA Monitor B", type: "MONITOR", brand: "LG", model: "27UL500", serialNumber: "QA-SN-0002" },
];

const DOCUMENT_SHEET = [
  {
    employeeEmail: "qa-doc@example.com",
    name: "QA Offer Letter",
    type: "OFFER_LETTER",
    fileUrl: "https://example.com/qa-offer.pdf",
    category: "Onboarding",
  },
  {
    employeeEmail: "qa-doc@example.com",
    name: "QA ID Proof",
    type: "ID_PROOF",
    fileUrl: "https://example.com/qa-id.pdf",
    category: "Identity",
  },
];

describeDb("HR import re-import idempotency — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({
        spec: "hr-import-idempotency.db.spec.ts",
        vars: ["DATABASE_URL", "APP_DATABASE_URL"],
      })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const service = new HrImportCommitService(stubAdmission(), stubPersonEmployment());
  const orgId = `qa-import-${randomUUID()}`;

  const ownerId = `qa-owner-${randomUUID()}`;
  const employeeId = `qa-employee-${randomUUID()}`;

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });
    // organizations.owner_membership_id and organization_members.org_id point at
    // each other, so neither row can be written first. The FK is DEFERRABLE
    // INITIALLY DEFERRED, so one transaction that writes both satisfies it at
    // commit — the same shape `MembershipMutations.allocateMembershipId` uses.
    await sql.begin(async (tx) => {
      await tx`insert into users (id, email, name) values (${ownerId}, ${`${ownerId}@example.com`}, ${"QA Owner"})`;
      const [membership] = await tx`
        select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id
      `;
      const membershipId = Number(membership?.id);
      await tx`
        insert into organizations (id, name, slug, owner_membership_id)
        values (${orgId}, ${"QA Import Co"}, ${orgId}, ${membershipId})
      `;
      await tx`
        insert into organization_members (id, org_id, user_id, role, status, is_owner)
        values (${membershipId}, ${orgId}, ${ownerId}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)
      `;
      // The document sheet names an employee by work email. That employee has to exist: a row that names nobody is
      // an error, not an organisation-wide document.
      await tx`insert into users (id, email, name) values (${employeeId}, ${`${employeeId}@example.com`}, ${"QA Employee"})`;
      const personId = randomUUID();
      await tx`insert into organization_people (organization_person_id, organization_id, user_id, first_name, last_name, work_email) values (${personId}, ${orgId}, ${employeeId}, ${"QA"}, ${"Employee"}, ${"qa-doc@example.com"})`;
      await tx`insert into hr_people (org_id, user_id, organization_person_id) values (${orgId}, ${employeeId}, ${personId})`;
    });
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id = ${orgId}`;
    await sql`delete from users where id = ${ownerId}`;
    await sql`delete from users where id = ${employeeId}`;
    await sql.end({ timeout: 5 });
  });

  /** Runs one sheet through the commit path exactly as `commitJob` does. */
  async function importSheet(
    entity: "assets" | "document_metadata",
    rows: ReadonlyArray<Record<string, unknown>>,
  ): Promise<CommitOutcome[]> {
    return db.transaction(async (tx) => {
      const outcomes: CommitOutcome[] = [];
      for (const row of rows) {
        const ref = await service.commitRow(tx, importContext(orgId), entity, row);
        if (ref) outcomes.push(ref.outcome);
      }
      return outcomes;
    });
  }

  const assetCount = async (): Promise<number> =>
    Number((await sql`select count(*)::int as n from assets where org_id = ${orgId}`)[0]?.n ?? -1);

  const documentCount = async (): Promise<number> =>
    Number((await sql`select count(*)::int as n from documents where org_id = ${orgId}`)[0]?.n ?? -1);

  it("creates each asset once and updates — never duplicates — on re-import", async () => {
    const first = await importSheet("assets", ASSET_SHEET);
    expect(first).toEqual(["created", "created"]);
    expect(await assetCount()).toBe(2);

    const second = await importSheet("assets", ASSET_SHEET);
    expect(second).toEqual(["updated", "updated"]);
    expect(await assetCount()).toBe(2);
  });

  it("matches a serial regardless of case and surrounding space", async () => {
    await importSheet("assets", [
      { ...ASSET_SHEET[0], name: "QA Laptop A (corrected)", serialNumber: "  qa-sn-0001  " },
    ]);

    const rows = await sql`
      select name from assets where org_id = ${orgId} and upper(trim(serial_number)) = ${"QA-SN-0001"}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("QA Laptop A (corrected)");
  });

  it("does not collapse two assets that carry no serial number", async () => {
    const before = await assetCount();
    await importSheet("assets", [
      { name: "QA Chair", type: "FURNITURE" },
      { name: "QA Desk", type: "FURNITURE" },
    ]);
    expect(await assetCount()).toBe(before + 2);
  });

  it("keeps an assignment the import sheet does not mention", async () => {
    const assignee = `qa-user-${randomUUID()}`;
    await sql`insert into users (id, email, name) values (${assignee}, ${`${assignee}@example.com`}, ${"QA Assignee"})`;
    await sql`update assets set assigned_to = ${assignee} where org_id = ${orgId} and serial_number = ${"QA-SN-0002"}`;

    // The sheet has no assignedToEmail column value for this row.
    await importSheet("assets", [ASSET_SHEET[1]]);

    const [row] = await sql`select assigned_to from assets where org_id = ${orgId} and serial_number = ${"QA-SN-0002"}`;
    expect(row?.assigned_to).toBe(assignee);
    await sql`update assets set assigned_to = null where org_id = ${orgId}`;
    await sql`delete from users where id = ${assignee}`;
  });

  it("creates each document once and does not double on re-import", async () => {
    const first = await importSheet("document_metadata", DOCUMENT_SHEET);
    expect(first).toEqual(["created", "created"]);
    expect(await documentCount()).toBe(2);

    const second = await importSheet("document_metadata", DOCUMENT_SHEET);
    expect(second).toEqual(["unchanged", "unchanged"]);
    expect(await documentCount()).toBe(2);
  });

  it("stores the document type the file names instead of flattening it to OTHER", async () => {
    const rows = await sql`
      select name, type from documents where org_id = ${orgId} order by name
    `;
    expect(rows.map((row) => [row.name, row.type])).toEqual([
      ["QA ID Proof", "ID_PROOF"],
      ["QA Offer Letter", "OFFER_LETTER"],
    ]);
  });

  it("treats two documents differing only by category as different documents", async () => {
    const before = await documentCount();
    await importSheet("document_metadata", [{ ...DOCUMENT_SHEET[0], category: "Compliance" }]);
    expect(await documentCount()).toBe(before + 1);
  });
});
