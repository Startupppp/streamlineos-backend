import { NotFoundException } from "@nestjs/common";
import { KbExportService } from "./kb-export.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";
const JOB_ID = 42;
const FILE_KEY = "kb-exports/org-1/42.md";
const FUTURE_EXPIRES = new Date(Date.now() + 3600 * 1000);
const PAST_EXPIRES = new Date(Date.now() - 1000);
const SIGNED_URL = "https://r2.example.com/signed?token=abc";

const auditMock = { log: jest.fn() };
const storageMock = {
  getFileUrl: jest.fn().mockResolvedValue(SIGNED_URL),
};

function makeDb(jobRow: Record<string, unknown> | null): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(jobRow ? [jobRow] : []),
        }),
      }),
    }),
  } as unknown as Db;
}

function service(db: Db): KbExportService {
  return new KbExportService(db, auditMock as never, {} as never, storageMock as never);
}

describe("KbExportService.getExportJobDownload — presigned URL for a completed export file", () => {
  it("returns a signed URL that expires when the job expires, not a fresh maximum-lifetime URL", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      fileKey: FILE_KEY,
      expiresAt: FUTURE_EXPIRES,
      status: "completed",
    });
    const svc = service(db);

    const result = await svc.getExportJobDownload(ORG, JOB_ID);

    expect(result.downloadUrl).toBe(SIGNED_URL);
    const callArgs = storageMock.getFileUrl.mock.calls[0] as [string, string, number];
    const expiresIn = callArgs[2];
    expect(expiresIn).toBeLessThanOrEqual(3600);
    expect(expiresIn).toBeGreaterThan(3590);
  });

  it("throws NotFoundException when the job does not exist in the caller's org, so cross-tenant miss is 404", async () => {
    const db = makeDb(null);
    const svc = service(db);

    await expect(svc.getExportJobDownload(ORG, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when fileKey is null, because the export has no stored file to download", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      fileKey: null,
      expiresAt: FUTURE_EXPIRES,
      status: "completed",
    });
    const svc = service(db);

    await expect(svc.getExportJobDownload(ORG, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("throws NotFoundException when expiresAt has passed, honouring the job's own expiry rather than minting a fresh URL", async () => {
    const db = makeDb({
      id: JOB_ID,
      orgId: ORG,
      fileKey: FILE_KEY,
      expiresAt: PAST_EXPIRES,
      status: "completed",
    });
    const svc = service(db);

    await expect(svc.getExportJobDownload(ORG, JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
