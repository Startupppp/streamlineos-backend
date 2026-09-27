import { ConflictException, NotFoundException } from "@nestjs/common";
import { KbImportExportService } from "./kb-import-export.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

const ORG = "org-1";
const JOB_ID = 7;

const user: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  isOrgOwner: false,
} as CurrentUserContext;

const auditMock = { log: jest.fn() };
const planLimitsMock = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never;

const FAILED_ITEMS = [
  { title: "Page A", contentText: "content a" },
  { title: "Page B", externalId: "ext-1", externalSource: "confluence" },
];

function makeDb(
  jobRow: Record<string, unknown> | null,
  onInsert?: () => unknown,
): Db {
  return {
    query: {
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(null) },
      kbPages: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue(jobRow ? [jobRow] : []),
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(onInsert ? [onInsert()] : [{ id: 99 }]),
          }),
        }),
      };
      return cb(tx);
    }),
  } as unknown as Db;
}

function service(db: Db): KbImportExportService {
  return new KbImportExportService(db, auditMock as never, planLimitsMock);
}

describe("KbImportExportService.retryImportJob — replays only the failed items from a prior run", () => {
  it("returns a new pending job when the prior job has failed items stored in errorReport.retryItems, so the caller can track the retry separately", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      status: "completed",
      sourceType: "markdown",
      errorReport: { retryItems: FAILED_ITEMS },
    });
    const svc = service(db);

    const result = await svc.retryImportJob(user, JOB_ID);

    expect(result.status).toBe("pending");
    expect(result.jobId).toBeGreaterThan(0);
  });

  it("throws NotFoundException for a job not in the caller's org, because cross-tenant miss must be 404", async () => {
    const db = makeDb(null);
    const svc = service(db);

    await expect(svc.retryImportJob(user, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws ConflictException when the job has no retryItems in errorReport, because there is nothing to retry", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      status: "completed",
      sourceType: "markdown",
      errorReport: { failedTitles: ["Page A"] },
    });
    const svc = service(db);

    await expect(svc.retryImportJob(user, JOB_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it("throws ConflictException when the job is still pending, because retrying an in-flight job would duplicate work", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      status: "pending",
      sourceType: "markdown",
      errorReport: { retryItems: FAILED_ITEMS },
    });
    const svc = service(db);

    await expect(svc.retryImportJob(user, JOB_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it("throws ConflictException when the original job had sourceType support_kb, because importPagesSchema only accepts markdown/html/zip and an unretryable sourceType must not create a job", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      status: "failed",
      sourceType: "support_kb",
      errorReport: { retryItems: FAILED_ITEMS },
    });
    const svc = service(db);

    await expect(svc.retryImportJob(user, JOB_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
