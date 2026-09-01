import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FinanceReportExportService } from "./finance-report-export.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { StorageService } from "../../storage/storage.service";
import type { FinanceReportExportJobRow } from "./finance-report-export.service";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-fin-retry";
const MEMBERSHIP_ID = 11;

function makeJobRow(overrides: Partial<FinanceReportExportJobRow> = {}): FinanceReportExportJobRow {
  return {
    id: "job-a1b2c3",
    orgId: ORG,
    reportType: "vendor_statement",
    status: "running",
    attempt: 1,
    maxAttempts: 3,
    requestedByMembershipId: MEMBERSHIP_ID,
    filters: { reportType: "vendor_statement", from: "2024-01-01", to: "2024-12-31" },
    idempotencyKey: "idem-fin-1",
    requestHash: "sha256-fin-1",
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
  } as unknown as FinanceReportExportJobRow;
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
  };
  return { db, setCalls };
}

async function buildService(db: unknown) {
  const module = await Test.createTestingModule({
    providers: [
      FinanceReportExportService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: {} },
    ],
  }).compile();
  return module.get(FinanceReportExportService);
}

describe("FinanceReportExportService — retry, dead-letter and duplicate detection", () => {
  describe("fail() — retry counting", () => {
    it("F1: attempt < maxAttempts → status returns to pending (retry path)", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("transient error"));
      expect(setCalls[0]).toMatchObject({ status: "pending" });
    });

    it("F2: attempt equals maxAttempts → status moves to failed (dead-letter)", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 3, maxAttempts: 3 }), new Error("final attempt failed"));
      expect(setCalls[0]).toMatchObject({ status: "failed" });
    });

    it("F3: attempt > maxAttempts → still fails (safety boundary: not < means not pending)", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 7, maxAttempts: 3 }), new Error("over-limit"));
      expect(setCalls[0]).toMatchObject({ status: "failed" });
    });

    it("F4: lockedAt is always cleared to null regardless of retry decision", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("any"));
      expect(setCalls[0]).toMatchObject({ lockedAt: null });
    });

    it("F5: error message is stored and capped at 500 characters", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("x".repeat(600)));
      const msg = setCalls[0]?.errorMessage;
      expect(typeof msg).toBe("string");
      expect((msg as string).length).toBeLessThanOrEqual(500);
    });

    it("F6: non-Error thrown object — errorMessage is still a string", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      await svc.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), { code: 500, detail: "db crash" });
      expect(typeof setCalls[0]?.errorMessage).toBe("string");
    });

    it("F7: bite proof — swapping attempt and maxAttempts flips the outcome", async () => {
      const { db: dbRetry, setCalls: retrySet } = makeUpdateDb();
      const svcRetry = await buildService(dbRetry);
      await svcRetry.fail(makeJobRow({ attempt: 1, maxAttempts: 3 }), new Error("a"));
      expect(retrySet[0]).toMatchObject({ status: "pending" });

      const { db: dbFail, setCalls: failSet } = makeUpdateDb();
      const svcFail = await buildService(dbFail);
      await svcFail.fail(makeJobRow({ attempt: 3, maxAttempts: 3 }), new Error("a"));
      expect(failSet[0]).toMatchObject({ status: "failed" });
    });
  });

  describe("reclaim() — stale lock recovery", () => {
    it("R1: resets stale running job to pending and clears lockedAt", async () => {
      const { db, setCalls } = makeUpdateDb();
      const svc = await buildService(db);
      const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
      await svc.reclaim(ORG, staleBefore);
      expect(setCalls[0]).toMatchObject({ status: "pending", lockedAt: null });
    });
  });

  describe("create() — duplicate idempotency key detection", () => {
    function makeUser(): CurrentUserContext {
      return {
        userId: "user-fin-1",
        orgId: ORG,
        isOrgOwner: false,
        principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
      } as unknown as CurrentUserContext;
    }

    it("D1: same idempotency key with different filters throws BadRequestException", async () => {
      const existingJob = makeJobRow({
        requestedByMembershipId: MEMBERSHIP_ID,
        requestHash: "sha256-from-different-filters",
        status: "pending",
      });

      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([existingJob]),
            }),
          }),
        }),
      };

      const db = {
        transaction: jest.fn().mockImplementation(
          async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock),
        ),
      };

      const svc = await buildService(db);

      await expect(
        svc.create(
          makeUser(),
          { reportType: "vendor_statement", from: "2024-01-01", to: "2024-12-31" },
          "idem-fin-1",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("D2: same key reused by a different member throws BadRequestException", async () => {
      const existingJob = makeJobRow({
        requestedByMembershipId: 999,
        requestHash: "sha256-fin-1",
        status: "pending",
      });

      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([existingJob]),
            }),
          }),
        }),
      };

      const db = {
        transaction: jest.fn().mockImplementation(
          async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock),
        ),
      };

      const svc = await buildService(db);

      await expect(
        svc.create(
          makeUser(),
          { reportType: "vendor_statement", from: "2024-01-01", to: "2024-12-31" },
          "idem-fin-1",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
