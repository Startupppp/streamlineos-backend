import { and, eq, isNull, sql } from "drizzle-orm";
import { CrmImportService } from "src/modules/crm/import/crm-import.service";
import { CrmExportService } from "src/modules/crm/import/crm-export.service";
import { rowWindows } from "src/modules/crm/import/import-batches";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { businessParties } from "src/db/schema";
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
 *
 * Committing is a durable workflow rather than one call, so this file walks the
 * batches itself — `beginCommit`, a `commitBatch` per row window, `finishCommit`
 * — which is exactly what `CrmImportWorkflow` does around `step.run`. Driving
 * the same three methods keeps the assertions on the service that does the work
 * rather than on the step machinery, and the windows come from the production
 * `rowWindows` so a batch here means the rows a batch means in a real run.
 */
describe("[seeded-e2e] CRM import round trip", () => {
  let seededApp: SeededE2eApp;
  let imports: CrmImportService;
  let exports: CrmExportService;
  let orgId: string;
  let userId: string;

  const inTenant = async <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seededApp.app.get<Db>(DRIZZLE), orgId, work);

  const commitAll = async (crmImportId: string) => {
    const total = { created: 0, updated: 0, merged: 0, review: 0, skipped: 0, failed: 0 };
    const extent = await inTenant(() => imports.beginCommit(orgId, crmImportId));
    if (extent.settled) return total;

    for (const window of rowWindows(extent.maxRowNumber)) {
      const outcome = await inTenant(() => imports.commitBatch(orgId, crmImportId, window));
      total.created += outcome.created;
      total.updated += outcome.updated;
      total.merged += outcome.merged;
      total.review += outcome.review;
      total.skipped += outcome.skipped;
      total.failed += outcome.failed;
    }

    await inTenant(() => imports.finishCommit(orgId, crmImportId));
    return total;
  };

  /**
   * Backwards, for the reason the workflow gives: a later row may have updated a
   * party an earlier row created, and undoing in file order would write the
   * update's before-image onto a record that is about to be soft-deleted.
   */
  const revertAll = async (crmImportId: string) => {
    const total = { deleted: 0, restored: 0, dismissed: 0, failed: 0 };
    const extent = await inTenant(() => imports.beginRevert(orgId, crmImportId));
    if (extent.settled) return total;

    for (const window of rowWindows(extent.maxRowNumber).reverse()) {
      const outcome = await inTenant(() => imports.revertBatch(orgId, crmImportId, window));
      total.deleted += outcome.deleted;
      total.restored += outcome.restored;
      total.dismissed += outcome.dismissed;
      total.failed += outcome.failed;
    }

    await inTenant(() => imports.finishRevert(orgId, crmImportId, userId));
    return total;
  };

  /** What the export would carry: this tenant's parties that have not been taken back. */
  const livingParties = () =>
    inTenant(() =>
      seededApp.app
        .get<Db>(DRIZZLE)
        .select()
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, orgId),
            isNull(businessParties.deletedAt),
          ),
        ),
    );

  const exportCsv = () =>
    inTenant(async () => {
      let csv = "";
      for await (const chunk of exports.csvChunks(orgId, "parties")) csv += chunk;
      return csv;
    });

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

      // Row 3 repeats row 1 and is folded into it: `merge` is its own outcome now,
      // and counting it as a skip would say the file wrote nothing for that row.
      expect(preview.summary).toMatchObject({
        create: 2,
        update: 0,
        merge: 1,
        skip: 1,
        review: 0,
        total: 4,
      });
      expect(preview.needsConfirmation).toHaveLength(0);

      // ── The committed result matches the preview ────────────────────────
      const committed = await commitAll(preview.crmImportId);
      expect(committed).toMatchObject({ created: 2, updated: 0, failed: 0 });

      const afterImport = await livingParties();
      expect(afterImport).toHaveLength(2);

      const acme = afterImport.find((row) => row.name === "Acme Trading Ltd");
      expect(acme).toMatchObject({ email: "ops@acme.example", taxNumber: "GST-111" });
      // A column the user could see in their file is findable afterwards.
      expect(acme?.customFields).toEqual({ territory: "North" });
      // "Company Phone" is a phone, not a name.
      expect(acme?.phone).toBe("+441234567890");

      // ── Export round-trips ──────────────────────────────────────────────
      const csv = await exportCsv();
      expect(csv.split("\n")).toHaveLength(3); // header + two records
      expect(csv).toContain("Acme Trading Ltd");

      // ── One action takes the whole thing back ───────────────────────────
      const reverted = await revertAll(preview.crmImportId);
      expect(reverted).toMatchObject({ deleted: 2, restored: 0 });

      const afterRevert = await livingParties();
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

      await commitAll(preview.crmImportId);

      const [updated] = await inTenant(() =>
        seededApp.seedDb.execute(sql`SELECT email, tax_number, notes FROM business_parties WHERE party_id = ${partyId}`),
      );
      expect(updated).toMatchObject({ tax_number: "GST-777" });
      // An import fills gaps; it does not overwrite what a person curated.
      expect(updated).toMatchObject({ notes: "Curated by a human" });

      await revertAll(preview.crmImportId);

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

  /**
   * Two halves of one promise, because the commit is durable now.
   *
   * `startCommit` is what a person's second click reaches, and it refuses. But a
   * workflow ATTEMPT re-executes its handler from the top, so `beginCommit` must
   * not refuse — it has to report the phase already settled, or a retry after a
   * deploy would fail a run whose work was already done.
   */
  it("refuses a second commit, while a retried run finds the phase settled", async () => {
    const preview = await inTenant(() =>
      imports.preview({
        organizationId: orgId,
        userId,
        headers: ["Company Name"],
        rows: [["Double Commit Ltd"]],
      }),
    );

    await commitAll(preview.crmImportId);

    await expect(imports.startCommit(orgId, preview.crmImportId)).rejects.toThrow(
      /already committed/i,
    );
    await expect(inTenant(() => imports.beginCommit(orgId, preview.crmImportId))).resolves.toMatchObject({
      settled: true,
    });

    await revertAll(preview.crmImportId);
  }, 180_000);
});
