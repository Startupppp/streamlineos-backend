import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { workflowRuns } from "src/db/schema";
import { CrmImportService } from "src/modules/crm/import/crm-import.service";
import { CrmExportService, type ExportEntity } from "src/modules/crm/import/crm-export.service";
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

  /**
   * Committing and reverting are durable runs, not method calls.
   *
   * `commit()` and `revert()` were single-shot and are gone: an import of any
   * size has to survive a restart mid-file, so the service now claims a run and
   * the workflow walks it in batches. Driving it here through the real cron
   * endpoint rather than by calling `commitBatch` in a loop is the point — a
   * runtime that is unregistered, unclaimable or dead-lettering fails this file,
   * and that is the failure calling the phases by hand cannot see.
   */
  async function drive(workflowRunId: string): Promise<string> {
    for (let pass = 0; pass < 12; pass += 1) {
      const res = await request(seededApp.app.getHttpServer())
        .post("/cron/workflow-tick")
        .set("Authorization", `Bearer ${process.env.CRON_SECRET ?? ""}`);
      expect(res.status).toBe(200);

      const [run] = await seededApp.seedDb
        .select({ status: workflowRuns.status, runAfter: workflowRuns.runAfter })
        .from(workflowRuns)
        .where(eq(workflowRuns.workflowRunId, workflowRunId));
      if (!run) throw new Error(`workflow run ${workflowRunId} disappeared`);
      if (run.status === "COMPLETED" || run.status === "DEAD_LETTERED") return run.status;

      const waitMs = Math.min(Math.max(run.runAfter.getTime() - Date.now(), 0) + 100, 3_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return "STUCK";
  }

  /**
   * The exporter streams now: `rowsFor` and `toCsv` are gone, replaced by
   * generators a response can be written with straight from the database. An
   * export of a departing tenant's whole CRM cannot be assembled in memory
   * first, which is the point — so the test collects the chunks the way the
   * controller writes them.
   */
  async function exportedRows(entity: ExportEntity): Promise<Record<string, unknown>[]> {
    return inTenant(async () => {
      let out = "";
      for await (const chunk of exports.jsonChunks(orgId, entity)) out += chunk;
      return JSON.parse(out) as Record<string, unknown>[];
    });
  }

  async function exportedCsv(entity: ExportEntity): Promise<string> {
    return inTenant(async () => {
      let out = "";
      for await (const chunk of exports.csvChunks(orgId, entity)) out += chunk;
      return out;
    });
  }

  async function commit(crmImportId: string) {
    const runId = await inTenant(() => imports.startCommit(orgId, crmImportId));
    expect(await drive(runId)).toBe("COMPLETED");
    return inTenant(() => imports.progress(orgId, crmImportId));
  }

  async function revert(crmImportId: string) {
    const runId = await inTenant(() => imports.startRevert(orgId, userId, crmImportId));
    expect(await drive(runId)).toBe("COMPLETED");
    return inTenant(() => imports.progress(orgId, crmImportId));
  }

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

      // `merge`, not a second `skip`: row 3 repeats row 1 under a different name
      // and the same address, and the planner folds it into that row rather than
      // discarding it. The bucket did not exist when this expectation was written.
      expect(preview.summary).toMatchObject({ create: 2, update: 0, merge: 1, skip: 1, total: 4 });
      expect(preview.needsConfirmation).toHaveLength(0);

      // ── The committed result matches the preview ────────────────────────
      const committed = await commit(preview.crmImportId);
      expect(committed).toMatchObject({ created: 2, updated: 0, failed: 0, complete: true });

      const afterImport = await exportedRows("parties");
      expect(afterImport).toHaveLength(2);

      const acme = afterImport.find((row) => row.name === "Acme Trading Ltd");
      expect(acme).toMatchObject({ email: "ops@acme.example", taxNumber: "GST-111" });
      // A column the user could see in their file is findable afterwards.
      expect(acme?.customFields).toEqual({ territory: "North" });
      // "Company Phone" is a phone, not a name.
      expect(acme?.phone).toBe("+441234567890");

      // ── Export round-trips ──────────────────────────────────────────────
      const csv = await exportedCsv("parties");
      expect(csv.split("\n")).toHaveLength(3); // header + two records
      expect(csv).toContain("Acme Trading Ltd");

      // ── One action takes the whole thing back ───────────────────────────
      const reverted = await revert(preview.crmImportId);
      // Four, not two. `progress.reverted` counts rows the revert walked —
      // `reverted_at is not null` — and it walks every committed row including
      // the skip and the merge, which is what makes the file as a whole undone.
      // The old single-shot `revert()` returned records affected instead. What
      // the criterion is actually about is the line below: nothing is left.
      expect(reverted).toMatchObject({ reverted: 4, complete: true });

      const afterRevert = await exportedRows("parties");
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

      await commit(preview.crmImportId);

      const [updated] = await inTenant(() =>
        seededApp.seedDb.execute(sql`SELECT email, tax_number, notes FROM business_parties WHERE party_id = ${partyId}`),
      );
      expect(updated).toMatchObject({ tax_number: "GST-777" });
      // An import fills gaps; it does not overwrite what a person curated.
      expect(updated).toMatchObject({ notes: "Curated by a human" });

      await revert(preview.crmImportId);

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

    await commit(preview.crmImportId);
    // A committed import cannot be claimed again: `claimForCommit` refuses any
    // status but `previewing` or `committing`, which is what stops a retried
    // request creating every row twice.
    await expect(inTenant(() => imports.startCommit(orgId, preview.crmImportId))).rejects.toThrow();

    await revert(preview.crmImportId);
  }, 180_000);
});
