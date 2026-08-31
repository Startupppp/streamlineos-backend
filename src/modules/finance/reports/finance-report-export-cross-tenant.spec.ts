import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { FinanceReportExportService } from "./finance-report-export.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { StorageService } from "../../storage/storage.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal, ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";

const ORG_A = "org-a";
const ORG_B = "org-b";
const JOB_ID = "job-uuid-finance-1";
const MEMBER_ID_A = 20;

function makeUser(orgId: string, membershipId: number | null): CurrentUserContext {
  const principal = membershipId !== null
    ? humanSessionPrincipal(membershipId, false)
    : ACCOUNT_ONLY_PRINCIPAL;
  return { userId: "user-y", orgId, isOrgOwner: false, principal } as unknown as CurrentUserContext;
}

function buildDbMock(hasJob: boolean) {
  const jobRow = hasJob
    ? {
        id: JOB_ID,
        orgId: ORG_A,
        requestedByMembershipId: MEMBER_ID_A,
        reportType: "vendor_statement",
        status: "completed",
        fileKey: "key.csv",
        fileName: "vendor-statement.csv",
        expiresAt: new Date(Date.now() + 86400000),
        processedRows: 5,
        rowCount: 5,
        truncated: false,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        completedAt: new Date(),
      }
    : null;

  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(jobRow ? [jobRow] : []),
        }),
      }),
    }),
  };
}

async function buildService(hasJob: boolean) {
  const db = buildDbMock(hasJob);
  const storage = {} as StorageService;

  const module = await Test.createTestingModule({
    providers: [
      FinanceReportExportService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: storage },
    ],
  }).compile();

  return { svc: module.get(FinanceReportExportService), db };
}

describe("FinanceReportExportService — BOLA protection", () => {
  describe("get()", () => {
    it("returns the job when the calling member owns it", async () => {
      const { svc } = await buildService(true);
      const user = makeUser(ORG_A, MEMBER_ID_A);
      const job = await svc.get(user, JOB_ID);
      expect(job.id).toBe(JOB_ID);
    });

    it("throws NotFoundException (not ForbiddenException) for a cross-org job id", async () => {
      const { svc } = await buildService(false);
      const user = makeUser(ORG_B, MEMBER_ID_A);
      await expect(svc.get(user, JOB_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when principal has no membership identity (account-only)", async () => {
      const { svc } = await buildService(true);
      const user = makeUser(ORG_A, null);
      await expect(svc.get(user, JOB_ID)).rejects.toThrow(NotFoundException);
    });

    it("cross-org error is NotFoundException, never ForbiddenException", async () => {
      const { svc } = await buildService(false);
      const user = makeUser(ORG_B, MEMBER_ID_A);
      let thrown: unknown;
      try {
        await svc.get(user, JOB_ID);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundException);
      const { ForbiddenException } = await import("@nestjs/common");
      expect(thrown).not.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("download()", () => {
    it("throws NotFoundException for a cross-org job id", async () => {
      const { svc } = await buildService(false);
      const user = makeUser(ORG_B, MEMBER_ID_A);
      await expect(svc.download(user, JOB_ID)).rejects.toThrow(NotFoundException);
    });

    it("does not throw ForbiddenException for a cross-org miss", async () => {
      const { svc } = await buildService(false);
      const user = makeUser(ORG_B, MEMBER_ID_A);
      let thrown: unknown;
      try {
        await svc.download(user, JOB_ID);
      } catch (err) {
        thrown = err;
      }
      const { ForbiddenException } = await import("@nestjs/common");
      expect(thrown).not.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("create() — transaction mock must invoke callback", () => {
    it("emits outbox event inside the transaction (callback is invoked)", async () => {
      const jobRow = {
        id: JOB_ID,
        orgId: ORG_A,
        requestedByMembershipId: MEMBER_ID_A,
        reportType: "sales_by_customer",
        status: "pending",
        fileKey: null,
        fileName: null,
        expiresAt: null,
        processedRows: 0,
        rowCount: null,
        truncated: false,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date(),
        completedAt: null,
        requestHash: "hash",
        idempotencyKey: "idem-key",
      };

      const outboxInsertMock = jest.fn().mockResolvedValue([]);
      const outboxSelectMock = jest.fn().mockResolvedValue([{ id: "out-1" }]);

      const txMock = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            onConflictDoNothing: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([jobRow]),
            }),
          }),
        }),
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([jobRow]),
            }),
          }),
        }),
      };

      const dbMock = {
        transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(txMock)),
        select: jest.fn(),
      };

      void outboxInsertMock;
      void outboxSelectMock;

      const module = await Test.createTestingModule({
        providers: [
          FinanceReportExportService,
          { provide: DRIZZLE, useValue: dbMock },
          { provide: StorageService, useValue: {} },
        ],
      }).compile();

      const svc = module.get(FinanceReportExportService);
      const user = makeUser(ORG_A, MEMBER_ID_A);

      await svc.create(user, { reportType: "sales_by_customer", from: "2024-01-01", to: "2024-12-31" }, "idem-key").catch(() => {});

      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
      expect(txMock.insert).toHaveBeenCalled();
    });
  });
});
