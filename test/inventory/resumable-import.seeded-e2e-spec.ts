import { sql } from "drizzle-orm";
import { DRIZZLE } from "src/db/drizzle.constants";
import type { Db } from "src/db/drizzle.module";
import { runInNewTenantTransaction } from "src/common/tenant/run-in-tenant-transaction";
import { StagedImportService } from "src/modules/inventory/import-export/staged-import.service";
import { createSeededE2eApp, type SeededE2eApp } from "test/helpers/seeded-e2e-app";
import { seedOrg } from "test/helpers/seed-builder";

/**
 * INV-108 — a hundred thousand rows, resumably.
 *
 * The importer this replaces took rows in the request body, capped at 10,000,
 * and applied them inside the request's transaction. The requirement is 100,000
 * with durable checkpoints, so the two things worth proving are that the volume
 * is expressible at all and that an interrupted run resumes without re-applying
 * what already landed.
 *
 * The applier here is deliberately trivial. What is under test is the staging,
 * claiming, checkpointing and retry behaviour — not the products importer, which
 * has its own validation tests.
 *
 *   pnpm test:e2e:seeded --testPathPattern=resumable-import
 */

const ROW_TOTAL = 100_000;
const STAGE_CHUNK = 5_000;

describe("[seeded-e2e] resumable import at 100k rows", () => {
  let seededApp: SeededE2eApp;
  let orgId: string;
  let userId: string;
  let staged: StagedImportService;
  let teardown: () => Promise<void>;

  const asTenant = <T>(work: () => Promise<T>): Promise<T> =>
    runInNewTenantTransaction(seededApp.app.get<Db>(DRIZZLE), orgId, work);

  beforeAll(async () => {
    seededApp = await createSeededE2eApp();
    const seeded = await seedOrg(seededApp.seedDb)
      .onPlan("PAID")
      .addMember("importer", { permissionKeys: ["inventory:import"] })
      .build();
    orgId = seeded.orgId;
    userId = seeded.members.importer!.userId;
    teardown = () => seeded.teardown();
    staged = seededApp.app.get(StagedImportService);
  }, 180_000);

  afterAll(async () => {
    await teardown?.().catch(() => undefined);
    await seededApp.close();
  });

  /** Rows are `uom` type: two required fields, no lookups, no stock movement. */
  function chunkAt(offset: number, size: number) {
    return Array.from({ length: size }, (_, i) => ({
      rowNumber: offset + i + 1,
      payload: { name: `Unit ${String(offset + i)}`, abbreviation: `U${String(offset + i)}` },
    }));
  }

  it(
    "stages a hundred thousand rows, then applies them across resumed chunks",
    async () => {
      const job = await asTenant(() =>
        staged.createJob(orgId, userId, {
          importType: "uom",
          fileName: "units.csv",
          totalRows: ROW_TOTAL,
          checksum: "sha256:100k-fixture",
          idempotencyKey: "import-100k",
          chunkSize: 1000,
        }),
      );

      for (let offset = 0; offset < ROW_TOTAL; offset += STAGE_CHUNK) {
        await asTenant(() => staged.stageRows(orgId, job.id, chunkAt(offset, STAGE_CHUNK)));
      }

      const afterStaging = await asTenant(() => staged.progress(orgId, job.id));
      expect(afterStaging.stagedRows).toBe(ROW_TOTAL);
      expect(afterStaging.appliedRows).toBe(0);

      // Every chunk is a separate call, exactly as a caller resuming after a
      // crash would make them. Nothing carries over but the row status.
      let progress = afterStaging;
      let calls = 0;
      while (!progress.finished) {
        progress = await asTenant(() =>
          staged.processChunk(orgId, userId, job.id, async () => null),
        );
        calls++;
        if (calls > 200) throw new Error("processing did not converge");
      }

      expect(progress.appliedRows).toBe(ROW_TOTAL);
      expect(progress.failedRows).toBe(0);
      expect(progress.status).toBe("COMPLETED");
      // 100k rows at 1000 per call, plus the final call that finds none left.
      expect(calls).toBe(ROW_TOTAL / 1000 + 1);
    },
    600_000,
  );

  it("re-opening with the same key returns the same job rather than a second one", async () => {
    const again = await asTenant(() =>
      staged.createJob(orgId, userId, {
        importType: "uom",
        totalRows: ROW_TOTAL,
        checksum: "sha256:100k-fixture",
        idempotencyKey: "import-100k",
      }),
    );
    const rows = await asTenant(() =>
      seededApp.app.get<Db>(DRIZZLE).execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM inv_import_jobs
        WHERE org_id = ${orgId} AND idempotency_key = 'import-100k'`),
    );
    expect(rows[0]!.n).toBe(1);
    expect(again.totalRows).toBe(ROW_TOTAL);
  });

  it("refuses the same key for a different file", async () => {
    await expect(
      asTenant(() =>
        staged.createJob(orgId, userId, {
          importType: "uom",
          totalRows: 10,
          checksum: "sha256:a-different-file",
          idempotencyKey: "import-100k",
        }),
      ),
    ).rejects.toThrow(/already used for a different file/);
  });

  it("applies a row once even when the chunk is processed twice", async () => {
    const job = await asTenant(() =>
      staged.createJob(orgId, userId, {
        importType: "uom",
        totalRows: 10,
        checksum: "sha256:replay",
        idempotencyKey: "import-replay",
        chunkSize: 10,
      }),
    );
    await asTenant(() => staged.stageRows(orgId, job.id, chunkAt(0, 10)));

    let applications = 0;
    const counting = async () => {
      applications++;
      return null;
    };

    await asTenant(() => staged.processChunk(orgId, userId, job.id, counting));
    // The second call finds nothing PENDING: status is the guard, not the cursor.
    await asTenant(() => staged.processChunk(orgId, userId, job.id, counting));

    expect(applications).toBe(10);
    const progress = await asTenant(() => staged.progress(orgId, job.id));
    expect(progress.appliedRows).toBe(10);
  });

  it("records a failing row without discarding the chunk around it", async () => {
    const job = await asTenant(() =>
      staged.createJob(orgId, userId, {
        importType: "uom",
        totalRows: 5,
        checksum: "sha256:partial",
        idempotencyKey: "import-partial",
        chunkSize: 10,
      }),
    );
    await asTenant(() => staged.stageRows(orgId, job.id, chunkAt(0, 5)));

    const progress = await asTenant(() =>
      staged.processChunk(orgId, userId, job.id, async (_o, _u, _j, rowNumber) =>
        rowNumber === 3
          ? { status: "FAILED" as const, code: "BAD_ROW", field: "abbreviation", message: "duplicate" }
          : null,
      ),
    );

    expect(progress.appliedRows).toBe(4);
    expect(progress.failedRows).toBe(1);

    const errors = await asTenant(() => staged.errors(orgId, job.id, 1, 50));
    expect(errors.total).toBe(1);
    expect(errors.items[0]).toMatchObject({ rowNumber: 3, code: "BAD_ROW", field: "abbreviation" });
  });

  it("a row that throws fails that row, not the job", async () => {
    const job = await asTenant(() =>
      staged.createJob(orgId, userId, {
        importType: "uom",
        totalRows: 3,
        checksum: "sha256:throws",
        idempotencyKey: "import-throws",
        chunkSize: 10,
      }),
    );
    await asTenant(() => staged.stageRows(orgId, job.id, chunkAt(0, 3)));

    const progress = await asTenant(() =>
      staged.processChunk(orgId, userId, job.id, async (_o, _u, _j, rowNumber) => {
        if (rowNumber === 2) throw new Error("applier exploded");
        return null;
      }),
    );

    expect(progress.appliedRows).toBe(2);
    expect(progress.failedRows).toBe(1);
    const errors = await asTenant(() => staged.errors(orgId, job.id, 1, 50));
    expect(errors.items[0]).toMatchObject({ rowNumber: 2, code: "APPLY_FAILED" });
  });

  it("cancelling stops the remaining rows and leaves the applied ones applied", async () => {
    const job = await asTenant(() =>
      staged.createJob(orgId, userId, {
        importType: "uom",
        totalRows: 20,
        checksum: "sha256:cancel",
        idempotencyKey: "import-cancel",
        chunkSize: 5,
      }),
    );
    await asTenant(() => staged.stageRows(orgId, job.id, chunkAt(0, 20)));
    await asTenant(() => staged.processChunk(orgId, userId, job.id, async () => null));

    const cancelled = await asTenant(() => staged.cancel(orgId, userId, job.id));
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.appliedRows).toBe(5);

    // Cancelling stops the work; it does not reverse what already happened.
    await expect(
      asTenant(() => staged.processChunk(orgId, userId, job.id, async () => null)),
    ).rejects.toThrow(/cancelled/);
  });

  it("hides a job from another tenant", async () => {
    const other = await seedOrg(seededApp.seedDb).onPlan("PAID").addMember("nosy").build();
    try {
      const job = await asTenant(() =>
        staged.createJob(orgId, userId, {
          importType: "uom",
          totalRows: 1,
          checksum: "sha256:isolation",
          idempotencyKey: "import-isolation",
        }),
      );
      // Out of tenant reads as absent, never as forbidden.
      await expect(
        runInNewTenantTransaction(seededApp.app.get<Db>(DRIZZLE), other.orgId, () =>
          staged.progress(other.orgId, job.id),
        ),
      ).rejects.toThrow(/not found/i);
    } finally {
      await other.teardown().catch(() => undefined);
    }
  });
});
