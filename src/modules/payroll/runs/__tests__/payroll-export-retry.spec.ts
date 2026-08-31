jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _explicit?: unknown) =>
    fn(_db),
  runInNewTenantTransaction: (
    _db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(_db),
}));

import { Test } from "@nestjs/testing";
import { PayrollRunExportService } from "../payroll-export.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { StorageService } from "../../../storage/storage.service";
import type { PayrollRunExportJobRow } from "../payroll-export.service";

const ORG = "org-payroll-retry";

function makeJobRow(overrides: Partial<PayrollRunExportJobRow> = {}): PayrollRunExportJobRow {
  return {
    id: "pay-export-001",
    orgId: ORG,
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    requestedByMembershipId: 7,
    filters: { runType: null, entityId: null, monthFrom: null, monthTo: null },
    idempotencyKey: "idem-pay-1",
    requestHash: "sha256-pay-1",
    processedRows: 0,
    rowCount: null,
    truncated: false,
    fileKey: null,
    fileName: null,
    fileSizeBytes: null,
    errorCode: null,
    errorMessage: null,
    lockedAt: new Date(),
    completedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as PayrollRunExportJobRow;
}

function makeUpdateDb() {
  const setCalls: Array<Record<string, unknown>> = [];
  const db = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockImplementation((vals: Record<string, unknown>) => {
        setCalls.push(vals);
        return { where: jest.fn().mockResolvedValue([]) };
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  };
  return { db, setCalls };
}

async function buildService(db: unknown) {
  const module = await Test.createTestingModule({
    providers: [
      PayrollRunExportService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: {} },
    ],
  }).compile();
  return module.get(PayrollRunExportService);
}

describe("PayrollRunExportService — retry and dead-letter", () => {
  describe("fail() — retry counting", () => {
    it("P1: attempt < maxAttempts → status returns to pending (retry path)", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("transient"));
      expect(setCalls[0]).toMatchObject({ status: "pending" });
    });

    it("P2: attempt equals maxAttempts → status moves to failed (dead-letter)", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 3, maxAttempts: 3 }), new Error("terminal"));
      expect(setCalls[0]).toMatchObject({ status: "failed" });
    });

    it("P3: attempt > maxAttempts → still fails (out-of-band safety)", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 9, maxAttempts: 3 }), new Error("over-limit"));
      expect(setCalls[0]).toMatchObject({ status: "failed" });
    });

    it("P4: lockedAt is always cleared to null", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 2, maxAttempts: 3 }), new Error("any"));
      expect(setCalls[0]).toMatchObject({ lockedAt: null });
    });

    it("P5: error message is stored and capped at 500 characters", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("y".repeat(700)));
      const msg = setCalls[0]?.errorMessage;
      expect(typeof msg).toBe("string");
      expect((msg as string).length).toBeLessThanOrEqual(500);
    });

    it("P6: non-Error thrown — errorMessage is still a string", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), "string error thrown");
      expect(typeof setCalls[0]?.errorMessage).toBe("string");
    });

    it("P7: bite proof — flipping attempt/maxAttempts reverses the status outcome", async () => {
      const { db: dbA, setCalls: setA } = makeUpdateDb();
      const svcA = await buildService(dbA);
      await svcA.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("a"));
      expect(setA[0]).toMatchObject({ status: "pending" });

      const { db: dbB, setCalls: setB } = makeUpdateDb();
      const svcB = await buildService(dbB);
      await svcB.fail(makeJobRow({ attempt: 3, maxAttempts: 3 }), new Error("b"));
      expect(setB[0]).toMatchObject({ status: "failed" });
    });
  });

  describe("reclaim() — stale lock recovery", () => {
    it("P8: resets stale running job to pending and clears lockedAt", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
      await svc.reclaim(ORG, staleBefore);
      expect(setCalls[0]).toMatchObject({ status: "pending", lockedAt: null });
    });
  });
});
