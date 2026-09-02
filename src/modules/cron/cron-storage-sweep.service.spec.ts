jest.mock("../../common/tenant", () => ({
  forEachOrg: jest.fn(
    async (
      _db: unknown,
      _sweep: string,
      fn: (tx: unknown, orgId: string) => Promise<void>,
    ) => {
      for (const id of (globalThis as { __sweepOrgIds?: string[] }).__sweepOrgIds ?? [])
        await fn({}, id);
      return { organizations: ((globalThis as { __sweepOrgIds?: string[] }).__sweepOrgIds ?? []).length };
    },
  ),
}));

import { CronStorageSweepService } from "./cron-storage-sweep.service";
import type { StorageMultipartService } from "../storage/storage-multipart.service";
import type { FileQuarantineService } from "../storage/file-quarantine.service";
import type { StorageService } from "../storage/storage.service";
import type { Db } from "../../db/drizzle.module";

const ORG_A = "org-aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "org-bbbbbbbb-0000-4000-8000-000000000002";

function makeOrgsDb(orgIds: string[]): Db {
  (globalThis as { __sweepOrgIds?: string[] }).__sweepOrgIds = orgIds;
  const selectBuilder = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue(orgIds.map((id) => ({ id }))),
  };
  return { select: jest.fn().mockReturnValue(selectBuilder) } as unknown as Db;
}

function makeServices() {
  const mockMultipart: jest.Mocked<Pick<StorageMultipartService, "sweepAbandonedUploads">> = {
    sweepAbandonedUploads: jest.fn().mockResolvedValue(0),
  };
  const mockQuarantine: jest.Mocked<
    Pick<FileQuarantineService, "listForSweep" | "softDelete">
  > = {
    listForSweep: jest.fn().mockResolvedValue([]),
    softDelete: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage: jest.Mocked<Pick<StorageService, "deleteFile">> = {
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
  return { mockMultipart, mockQuarantine, mockStorage };
}

function buildService(orgIds: string[]) {
  const db = makeOrgsDb(orgIds);
  const { mockMultipart, mockQuarantine, mockStorage } = makeServices();
  const svc = new CronStorageSweepService(
    db,
    mockMultipart as never,
    mockQuarantine as never,
    mockStorage as never,
  );
  return { svc, db, mockMultipart, mockQuarantine, mockStorage };
}

describe("CronStorageSweepService.sweep — sweepAbandonedUploads is called", () => {
  it("calls sweepAbandonedUploads for every active org — no caller had caused this to run before", async () => {
    const { svc, mockMultipart } = buildService([ORG_A, ORG_B]);

    await svc.sweep();

    expect(mockMultipart.sweepAbandonedUploads).toHaveBeenCalledTimes(2);
    expect(mockMultipart.sweepAbandonedUploads).toHaveBeenCalledWith(ORG_A);
    expect(mockMultipart.sweepAbandonedUploads).toHaveBeenCalledWith(ORG_B);
  });

  it("queries infected/error and stale pending_scan records per org", async () => {
    const { svc, mockQuarantine } = buildService([ORG_A]);

    await svc.sweep();

    expect(mockQuarantine.listForSweep).toHaveBeenCalledWith(
      ORG_A,
      ["infected", "error"],
      expect.any(Date),
      expect.any(Number),
    );
    expect(mockQuarantine.listForSweep).toHaveBeenCalledWith(
      ORG_A,
      ["pending_scan"],
      expect.any(Date),
      expect.any(Number),
    );
  });

  it("soft-deletes expired quarantine records and deletes S3 objects", async () => {
    const staleRecord = { id: "qr-1", storageKey: "org-1/uploads/file.pdf" };
    const { svc, mockQuarantine, mockStorage } = buildService([ORG_A]);
    mockQuarantine.listForSweep.mockResolvedValueOnce([staleRecord]).mockResolvedValue([]);

    await svc.sweep();

    expect(mockStorage.deleteFile).toHaveBeenCalledWith(ORG_A, staleRecord.storageKey);
    expect(mockQuarantine.softDelete).toHaveBeenCalledWith(staleRecord.id);
  });

  it("accumulates the count of aborted uploads in the result", async () => {
    const { svc, mockMultipart } = buildService([ORG_A, ORG_B]);
    mockMultipart.sweepAbandonedUploads.mockResolvedValueOnce(3).mockResolvedValueOnce(1);

    const result = await svc.sweep();

    expect(result.multipartAborted).toBe(4);
    expect(result.organizations).toBe(2);
  });

  it("continues sweeping remaining orgs when one org's multipart sweep fails", async () => {
    const { svc, mockMultipart } = buildService([ORG_A, ORG_B]);
    mockMultipart.sweepAbandonedUploads
      .mockRejectedValueOnce(new Error("S3 unreachable"))
      .mockResolvedValueOnce(2);

    const result = await svc.sweep();

    expect(result.multipartAborted).toBe(2);
    expect(result.organizations).toBe(2);
  });

  it("keeps the quarantine record when the S3 delete fails, so an infected key stays blocked", async () => {
    const { svc, mockQuarantine, mockStorage } = buildService([ORG_A]);
    mockQuarantine.listForSweep
      .mockResolvedValueOnce([{ id: "q-1", storageKey: `${ORG_A}/uploads/infected.exe` }] as never)
      .mockResolvedValueOnce([] as never);
    mockStorage.deleteFile.mockRejectedValueOnce(new Error("S3 unreachable"));

    const result = await svc.sweep();

    expect(mockQuarantine.softDelete).not.toHaveBeenCalled();
    expect(result.quarantineExpired).toBe(0);
    expect(result.s3ObjectsDeleted).toBe(0);
    expect(result.deleteFailures).toBe(1);
  });

  it("soft-deletes the quarantine record only after the object is gone", async () => {
    const { svc, mockQuarantine, mockStorage } = buildService([ORG_A]);
    mockQuarantine.listForSweep
      .mockResolvedValueOnce([{ id: "q-2", storageKey: `${ORG_A}/uploads/infected.exe` }] as never)
      .mockResolvedValueOnce([] as never);

    const result = await svc.sweep();

    expect(mockStorage.deleteFile).toHaveBeenCalledWith(ORG_A, `${ORG_A}/uploads/infected.exe`);
    expect(mockQuarantine.softDelete).toHaveBeenCalledWith("q-2");
    expect(result).toMatchObject({ quarantineExpired: 1, s3ObjectsDeleted: 1, deleteFailures: 0 });
  });
});
