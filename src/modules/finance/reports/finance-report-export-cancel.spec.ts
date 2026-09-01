import { ConflictException, NotFoundException } from "@nestjs/common";
import { FinanceReportExportService } from "./finance-report-export.service";
import type { FinanceReportExportJobRow } from "./finance-report-export.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const makeUser = (membershipId = 1, orgId = "org-a"): CurrentUserContext =>
  ({ orgId, principal: humanSessionPrincipal(membershipId, false) }) as unknown as CurrentUserContext;

const makeJob = (overrides: Partial<FinanceReportExportJobRow> = {}): FinanceReportExportJobRow =>
  ({
    id: "job-1",
    orgId: "org-a",
    requestedByMembershipId: 1,
    reportType: "tax_summary",
    status: "pending",
    filters: { reportType: "tax_summary", from: "2026-01-01", to: "2026-12-31" },
    idempotencyKey: "k1",
    requestHash: "h1",
    fileKey: null,
    fileName: null,
    mimeType: "text/csv",
    fileSizeBytes: null,
    processedRows: 0,
    rowCount: null,
    truncated: false,
    attempt: 0,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    lockedAt: null,
    completedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as FinanceReportExportJobRow;

function makeDb(findRows: FinanceReportExportJobRow[], updateRows: FinanceReportExportJobRow[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(findRows),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(updateRows),
        }),
      }),
    }),
  };
}

function makeService(db: ReturnType<typeof makeDb>) {
  return new FinanceReportExportService(db as never, {} as never);
}

describe("FinanceReportExportService.cancel()", () => {
  const user = makeUser(1, "org-a");

  it("C1: transitions pending job to cancelled and clears lockedAt", async () => {
    const job = makeJob({ status: "pending", lockedAt: null });
    const cancelled = { ...job, status: "cancelled" as const, lockedAt: null };
    const db = makeDb([job], [cancelled]);
    const svc = makeService(db);

    const result = await svc.cancel(user, "job-1");

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
  });

  it("C2: transitions running job to cancelled and clears lockedAt", async () => {
    const lockedAt = new Date();
    const job = makeJob({ status: "running", lockedAt });
    const cancelled = { ...job, status: "cancelled" as const, lockedAt: null };
    const db = makeDb([job], [cancelled]);
    const svc = makeService(db);

    const result = await svc.cancel(user, "job-1");

    expect(result.status).toBe("cancelled");
  });

  it("C3: throws ConflictException when job is completed", async () => {
    const job = makeJob({ status: "completed" });
    const db = makeDb([job], []);
    const svc = makeService(db);

    await expect(svc.cancel(user, "job-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("C4: throws ConflictException when job is failed", async () => {
    const job = makeJob({ status: "failed" });
    const db = makeDb([job], []);
    const svc = makeService(db);

    await expect(svc.cancel(user, "job-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("C5: throws ConflictException when job is expired", async () => {
    const job = makeJob({ status: "expired" });
    const db = makeDb([job], []);
    const svc = makeService(db);

    await expect(svc.cancel(user, "job-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("C6: throws ConflictException when job is already cancelled (idempotency guard)", async () => {
    const job = makeJob({ status: "cancelled" });
    const db = makeDb([job], []);
    const svc = makeService(db);

    await expect(svc.cancel(user, "job-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("C7: throws NotFoundException (BOLA) when job belongs to a different member", async () => {
    const db = makeDb([], []);
    const differentUser = makeUser(99, "org-a");
    const svc = makeService(db);

    await expect(svc.cancel(differentUser, "job-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("C8: throws NotFoundException (BOLA) when job belongs to a different org", async () => {
    const db = makeDb([], []);
    const differentOrgUser = makeUser(1, "org-b");
    const svc = makeService(db);

    await expect(svc.cancel(differentOrgUser, "job-1")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });
});
