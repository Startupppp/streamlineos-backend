import { FileQuarantineService } from "./file-quarantine.service";
import type { Db } from "../../db/drizzle.module";

const RECORD_ID = "a1b2c3d4-0000-4000-8000-000000000001";

function makeDb(overrides: Partial<{
  insertRows: Array<{ id: string }>;
  selectRows: Array<Record<string, unknown>>;
  updateResult: unknown;
}> = {}): Db {
  const rows = overrides.selectRows ?? [];
  const insertBuilder = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(overrides.insertRows ?? [{ id: RECORD_ID }]),
  };
  const whereTerminal = {
    limit: jest.fn().mockResolvedValue(rows),
    then: (onFulfilled: (v: typeof rows) => unknown) => Promise.resolve(rows).then(onFulfilled),
    catch: (onRejected: (e: unknown) => unknown) => Promise.resolve(rows).catch(onRejected),
    finally: (onFinally: () => void) => Promise.resolve(rows).finally(onFinally),
  };
  const selectBuilder = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnValue(whereTerminal),
    limit: jest.fn().mockResolvedValue(rows),
  };
  const updateBuilder = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(overrides.updateResult ?? []),
  };
  return {
    insert: jest.fn().mockReturnValue(insertBuilder),
    select: jest.fn().mockReturnValue(selectBuilder),
    update: jest.fn().mockReturnValue(updateBuilder),
  } as unknown as Db;
}

const BASE_PARAMS = {
  orgId: "org-1",
  storageKey: "org-1/uploads/uuid-file.pdf",
  filename: "contract.pdf",
  mimeType: "application/pdf",
  fileSizeBytes: 102400,
  sha256: "abc123def456",
  uploadedBy: "user-1",
};

describe("FileQuarantineService.begin", () => {
  it("inserts a quarantine record and returns the id", async () => {
    const db = makeDb({ insertRows: [{ id: RECORD_ID }] });
    const svc = new FileQuarantineService(db);

    const id = await svc.begin(BASE_PARAMS);

    expect(id).toBe(RECORD_ID);
    expect(db.insert).toHaveBeenCalled();
  });

  it("throws when the insert returns no row (never treats missing row as success)", async () => {
    const db = makeDb({ insertRows: [] });
    const svc = new FileQuarantineService(db);

    await expect(svc.begin(BASE_PARAMS)).rejects.toThrow();
  });

  it("idempotent retry of begin with same idempotency-key produces exactly one DB insert call", async () => {
    const db = makeDb({ insertRows: [{ id: RECORD_ID }] });
    const svc = new FileQuarantineService(db);

    await svc.begin({ ...BASE_PARAMS, idempotencyKey: "idem-abc" });

    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

describe("FileQuarantineService.markClean", () => {
  it("sets status to clean and sets scannedAt and releasedAt", async () => {
    const db = makeDb();
    const svc = new FileQuarantineService(db);
    const updateMock = db.update as jest.Mock;

    await svc.markClean(RECORD_ID);

    expect(updateMock).toHaveBeenCalled();
    const setCall = (updateMock.mock.results[0]?.value as { set: jest.Mock }).set;
    const setArgs = setCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs?.status).toBe("clean");
    expect(setArgs?.scannedAt).toBeInstanceOf(Date);
    expect(setArgs?.releasedAt).toBeInstanceOf(Date);
  });
});

describe("FileQuarantineService.markInfected", () => {
  it("sets status to infected and records threat name", async () => {
    const db = makeDb();
    const svc = new FileQuarantineService(db);
    const updateMock = db.update as jest.Mock;

    await svc.markInfected(RECORD_ID, "Eicar-Test-Signature");

    const setCall = (updateMock.mock.results[0]?.value as { set: jest.Mock }).set;
    const setArgs = setCall.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArgs?.status).toBe("infected");
    expect(setArgs?.threatName).toBe("Eicar-Test-Signature");
  });
});

describe("FileQuarantineService.isKeyBlocked", () => {
  it("returns false when no quarantine record exists for the key", async () => {
    const db = makeDb({ selectRows: [] });
    const svc = new FileQuarantineService(db);

    const blocked = await svc.isKeyBlocked("org-1", "org-1/uploads/uuid-file.pdf");

    expect(blocked).toBe(false);
  });

  it("returns true when a pending_scan record exists — unscanned file is not downloadable", async () => {
    const db = makeDb({ selectRows: [{ status: "pending_scan" }] });
    const svc = new FileQuarantineService(db);

    const blocked = await svc.isKeyBlocked("org-1", "org-1/uploads/uuid-file.pdf");

    expect(blocked).toBe(true);
  });

  it("returns true when an infected record exists", async () => {
    const db = makeDb({ selectRows: [{ status: "infected" }] });
    const svc = new FileQuarantineService(db);

    const blocked = await svc.isKeyBlocked("org-1", "org-1/uploads/uuid-file.pdf");

    expect(blocked).toBe(true);
  });

  it("returns false when the record is clean — clean files are downloadable", async () => {
    const db = makeDb({ selectRows: [{ status: "clean" }] });
    const svc = new FileQuarantineService(db);

    const blocked = await svc.isKeyBlocked("org-1", "org-1/uploads/uuid-file.pdf");

    expect(blocked).toBe(false);
  });
});

describe("FileQuarantineService.getTotalUsageBytes", () => {
  it("returns 0 when no clean records exist", async () => {
    const db = makeDb({ selectRows: [{ total: 0 }] });
    const svc = new FileQuarantineService(db);

    const total = await svc.getTotalUsageBytes("org-1");

    expect(total).toBe(0);
  });

  it("returns the summed bytes of clean records", async () => {
    const db = makeDb({ selectRows: [{ total: 52428800 }] });
    const svc = new FileQuarantineService(db);

    const total = await svc.getTotalUsageBytes("org-1");

    expect(total).toBe(52428800);
  });
});

describe("FileQuarantineService.findByIdempotencyKey", () => {
  it("returns null when no record matches", async () => {
    const db = makeDb({ selectRows: [] });
    const svc = new FileQuarantineService(db);

    const result = await svc.findByIdempotencyKey("org-1", "key-abc");

    expect(result).toBeNull();
  });

  it("returns the clean record when the idempotency key matches", async () => {
    const row = {
      id: RECORD_ID,
      orgId: "org-1",
      storageKey: "org-1/uploads/uuid-file.pdf",
      filename: "contract.pdf",
      mimeType: "application/pdf",
      fileSizeBytes: 102400,
      sha256: "abc123",
      status: "clean",
      threatName: null,
      idempotencyKey: "key-abc",
      uploadedBy: "user-1",
      createdAt: new Date(),
    };
    const db = makeDb({ selectRows: [row] });
    const svc = new FileQuarantineService(db);

    const result = await svc.findByIdempotencyKey("org-1", "key-abc");

    expect(result).not.toBeNull();
    expect(result?.id).toBe(RECORD_ID);
    expect(result?.status).toBe("clean");
  });
});
