import { sql } from "drizzle-orm";
import { CrmImportService } from "src/modules/crm-import/crm-import.service";
import { CrmExportService, toCsv } from "src/modules/crm-import/crm-export.service";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * Import and export against a real database.
 *
 * Two of this ticket's criteria are claims about behaviour that only a real
 * round trip can settle: that the committed result matches the preview, and
 * that reverting restores the prior state *exactly*. Both are asserted here by
 * doing it and reading back what happened.
 */
describe("[seeded-e2e] CRM import round trip", () => {
  let seededApp: SeededE2eApp;
  let imports: CrmImportService;
  let exports: CrmExportService;
  let orgId: string;
  let userId: string;

  const inTenant = async <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seededApp.app.get<Db>(DRIZZLE), orgId, work);

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
    imports = seededApp.app.get(CrmImportService);
    exports = seededApp.app.get(CrmExportService);

    const fixture = await seedOrg(seededApp.seedDb).addMember("importer").build();
    orgId = fixture.orgId;
    userId = fixture.members["importer"]!.userId;
  }, 180_000);

  afterAll(async () => {
    await seededApp?.close();
  });

  const HEADERS = ["Company Name", "Email", "Company Phone", "GSTIN", "Territory"];

  it(
    "previews, commits what it promised, and takes it all back",
    async () => {
      const rows = [
        ["Acme Trading Ltd", "ops@acme.example", "+441234567890", "GST-111", "North"],
        ["Globex Industries", "hello@globex.example", "", "", "South"],
        // A repeat of row 1, spelled differently.
        ["Acme Trading Limited", "ops@acme.example", "", "", ""],
        // Nothing to create.
        ["", "orphan@example.com", "", "", ""],
      ];

      const preview = await inTenant(() =>
        imports.preview({ organizationId: orgId, userId, headers: HEADERS, rows }),
      );

      expect(preview.summary).toMatchObject({ create: 2, update: 0, skip: 2, total: 4 });
      expect(preview.needsConfirmation).toHaveLength(0);

      // ── The committed result matches the preview ────────────────────────
      const committed = await inTenant(() => imports.commit(orgId, preview.crmImportId));
      expect(committed).toMatchObject({ created: 2, updated: 0, failed: 0 });

      const afterImport = await inTenant(() => exports.rowsFor(orgId, "parties"));
      expect(afterImport).toHaveLength(2);

      const acme = afterImport.find((row) => row.name === "Acme Trading Ltd");
      expect(acme).toMatchObject({ email: "ops@acme.example", taxNumber: "GST-111" });
      // A column the user could see in their file is findable afterwards.
      expect(acme?.customFields).toEqual({ territory: "North" });
      // "Company Phone" is a phone, not a name.
      expect(acme?.phone).toBe("+441234567890");

      // ── Export round-trips ──────────────────────────────────────────────
      const csv = toCsv(afterImport);
      expect(csv.split("\n")).toHaveLength(3); // header + two records
      expect(csv).toContain("Acme Trading Ltd");

      // ── One action takes the whole thing back ───────────────────────────
      const reverted = await inTenant(() => imports.revert(orgId, userId, preview.crmImportId));
      expect(reverted).toMatchObject({ deleted: 2, restored: 0 });

      const afterRevert = await inTenant(() => exports.rowsFor(orgId, "parties"));
      expect(afterRevert).toHaveLength(0);
    },
    180_000,
  );

  it(
    "restores an overwritten record exactly, which is the half people care about",
    async () => {
      const partyId = `import-test-${Date.now()}`;
      // Shares an email with the file, which is what makes it the same company.
      // A name on its own is not identity — see the test below.
      await seededApp.seedDb.execute(sql`
        INSERT INTO business_parties (party_id, organization_id, name, party_type, email, notes)
        VALUES (${partyId}, ${orgId}, 'Zenith Manufacturing', 'CUSTOMER', 'sales@zenith.example', 'Curated by a human')`);

      // A file that fills in the gaps on a party we already have.
      const preview = await inTenant(() =>
        imports.preview({
          organizationId: orgId,
          userId,
          headers: ["Company Name", "Email", "GSTIN"],
          rows: [["Zenith Manufacturing", "sales@zenith.example", "GST-777"]],
        }),
      );

      expect(preview.summary).toMatchObject({ update: 1, create: 0 });

      await inTenant(() => imports.commit(orgId, preview.crmImportId));

      const [updated] = await inTenant(() =>
        seededApp.seedDb.execute(sql`SELECT email, tax_number, notes FROM business_parties WHERE party_id = ${partyId}`),
      );
      expect(updated).toMatchObject({ tax_number: "GST-777" });
      // An import fills gaps; it does not overwrite what a person curated.
      expect(updated).toMatchObject({ notes: "Curated by a human" });

      await inTenant(() => imports.revert(orgId, userId, preview.crmImportId));

      const [restored] = await inTenant(() =>
        seededApp.seedDb.execute(sql`SELECT name, email, tax_number, notes FROM business_parties WHERE party_id = ${partyId}`),
      );
      // Exactly as it was: the gap the import filled is a gap again, and what a
      // person had curated was never touched in the first place.
      expect(restored).toMatchObject({
        name: "Zenith Manufacturing",
        email: "sales@zenith.example",
        tax_number: null,
        notes: "Curated by a human",
      });

      await seededApp.seedDb
        .execute(sql`DELETE FROM business_parties WHERE party_id = ${partyId}`)
        .catch(() => undefined);
    },
    180_000,
  );

  /**
   * A name on its own is not identity, and two companies can share one. Fusing
   * their histories is the expensive mistake and a later reversal cannot cleanly
   * separate them, so a bare name match creates a second record for the
   * duplicate queue to catch.
   */
  it("does not merge two companies on a matching name alone", async () => {
    const partyId = `name-only-${Date.now()}`;
    await seededApp.seedDb.execute(sql`
      INSERT INTO business_parties (party_id, organization_id, name, party_type)
      VALUES (${partyId}, ${orgId}, 'Northwind Traders', 'CUSTOMER')`);

    const preview = await inTenant(() =>
      imports.preview({
        organizationId: orgId,
        userId,
        headers: ["Company Name", "Email"],
        rows: [["Northwind Traders", "different@northwind.example"]],
      }),
    );

    expect(preview.summary).toMatchObject({ create: 1, update: 0 });
    expect(preview.rows[0]?.reason).toMatch(/not close enough|new to this/i);

    await seededApp.seedDb
      .execute(sql`DELETE FROM business_parties WHERE party_id = ${partyId}`)
      .catch(() => undefined);
  }, 180_000);

  it("refuses to commit the same import twice", async () => {
    const preview = await inTenant(() =>
      imports.preview({
        organizationId: orgId,
        userId,
        headers: ["Company Name"],
        rows: [["Double Commit Ltd"]],
      }),
    );

    await inTenant(() => imports.commit(orgId, preview.crmImportId));
    await expect(inTenant(() => imports.commit(orgId, preview.crmImportId))).rejects.toThrow();

    await inTenant(() => imports.revert(orgId, userId, preview.crmImportId));
  }, 180_000);
});
