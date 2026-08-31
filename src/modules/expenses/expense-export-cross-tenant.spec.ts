import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ExpenseExportService } from "./expense-export.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { StorageService } from "../storage/storage.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal, ACCOUNT_ONLY_PRINCIPAL } from "../../common/auth/principal";

const ORG_A = "org-a";
const ORG_B = "org-b";
const JOB_ID = "job-uuid-1";
const MEMBER_ID_A = 10;

function makeUser(orgId: string, membershipId: number | null): CurrentUserContext {
  const principal = membershipId !== null
    ? humanSessionPrincipal(membershipId, false)
    : ACCOUNT_ONLY_PRINCIPAL;
  return { userId: "user-x", orgId, isOrgOwner: false, principal } as unknown as CurrentUserContext;
}

function buildDbMock(hasJob: boolean) {
  const jobRow = hasJob
    ? {
        id: JOB_ID,
        orgId: ORG_A,
        requestedByMembershipId: MEMBER_ID_A,
        status: "completed",
        fileKey: "key.csv",
        fileName: "expenses.csv",
        expiresAt: new Date(Date.now() + 86400000),
        processedRows: 10,
        rowCount: 10,
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
      ExpenseExportService,
      { provide: DRIZZLE, useValue: db },
      { provide: StorageService, useValue: storage },
    ],
  }).compile();

  return { svc: module.get(ExpenseExportService), db };
}

describe("ExpenseExportService — BOLA protection", () => {
  describe("get()", () => {
    it("returns the job when the calling member owns it", async () => {
      const { svc } = await buildService(true);
      const user = makeUser(ORG_A, MEMBER_ID_A);
      const job = await svc.get(user, JOB_ID);
      expect(job.id).toBe(JOB_ID);
    });

    it("throws NotFoundException (not ForbiddenException) when no matching job is found for caller", async () => {
      const { svc } = await buildService(false);
      const user = makeUser(ORG_B, MEMBER_ID_A);
      await expect(svc.get(user, JOB_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when principal has no membership identity (account-only)", async () => {
      const { svc } = await buildService(true);
      const user = makeUser(ORG_A, null);
      await expect(svc.get(user, JOB_ID)).rejects.toThrow(NotFoundException);
    });

    it("error thrown for cross-org miss is NotFoundException, not ForbiddenException", async () => {
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
    it("throws NotFoundException for a job that is not found under caller's scope", async () => {
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
});
