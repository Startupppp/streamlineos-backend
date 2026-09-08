jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(mockTenantTx),
  ),
}));

interface PurgeMark {
  status: string;
  confirmedAt?: Date;
  lastAttemptedAt: Date;
  failedReason: string | null;
}

const mockPurgeMarks: PurgeMark[] = [];
const mockInsertValues = jest.fn();
const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockUpdateSet = jest.fn((mark: PurgeMark) => {
  mockPurgeMarks.push(mark);
  return { where: mockUpdateWhere };
});

const mockTenantTx = {
  insert: jest.fn(() => ({
    values: jest.fn((rows: unknown) => {
      mockInsertValues(rows);
      return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
    }),
  })),
  update: jest.fn(() => ({ set: mockUpdateSet })),
};

import {
  attemptPageAttachmentPurge,
  recordPageAttachmentPurge,
  KB_PAGE_ATTACHMENT_PURGE_PURPOSE,
} from "./kb-page-attachment-purge";

const ORG = "org-1";

// The attachment read gained an ORDER BY, so a double that resolves at .where() breaks on
// the query's shape rather than on its behaviour. This chain is thenable AND chainable.
function attachmentDb(rows: Array<{ fileKey: string }>) {
  const chain = {
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    then: <R,>(resolve: (value: Array<{ fileKey: string }>) => R) =>
      Promise.resolve(rows).then(resolve),
  };
  const where = jest.fn(() => chain);
  return {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
    where,
  };
}

describe("recordPageAttachmentPurge — the write-ahead record is opened before the row is cascaded away", () => {
  beforeEach(() => jest.clearAllMocks());

  it("opens one pending storage_pending_purge row per distinct file key", async () => {
    const db = attachmentDb([
      { fileKey: "kb-media/org-1/a.webp" },
      { fileKey: "kb-media/org-1/b.pdf" },
      { fileKey: "kb-media/org-1/a.webp" },
    ]);

    const keys = await recordPageAttachmentPurge(db as never, ORG, [10, 11]);

    expect(keys).toEqual(["kb-media/org-1/a.webp", "kb-media/org-1/b.pdf"]);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledWith([
      {
        orgId: ORG,
        storageKey: "kb-media/org-1/a.webp",
        purpose: KB_PAGE_ATTACHMENT_PURGE_PURPOSE,
        status: "pending",
      },
      {
        orgId: ORG,
        storageKey: "kb-media/org-1/b.pdf",
        purpose: KB_PAGE_ATTACHMENT_PURGE_PURPOSE,
        status: "pending",
      },
    ]);
  });

  it("writes nothing when the page set carries no attachments", async () => {
    const db = attachmentDb([]);
    await expect(recordPageAttachmentPurge(db as never, ORG, [10])).resolves.toEqual([]);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("reads no attachment rows at all for an empty page set", async () => {
    const db = attachmentDb([{ fileKey: "k" }]);
    await expect(recordPageAttachmentPurge(db as never, ORG, [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("bites: a failed write-ahead insert propagates, so the caller cannot go on to delete the page", async () => {
    const db = attachmentDb([{ fileKey: "kb-media/org-1/a.webp" }]);
    mockTenantTx.insert.mockImplementationOnce(() => {
      throw new Error("23514 storage_pending_purge");
    });

    await expect(recordPageAttachmentPurge(db as never, ORG, [10])).rejects.toThrow(
      "23514 storage_pending_purge",
    );
  });
});

const KB_BUCKET = "kb-files";

describe("attemptPageAttachmentPurge — best effort, never throwing back at the caller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPurgeMarks.length = 0;
  });

  it("deletes each object and confirms its row", async () => {
    const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };

    const result = await attemptPageAttachmentPurge(
      {} as never,
      storage,
      ORG,
      ["k1", "k2"],
      KB_BUCKET,
    );

    expect(result).toEqual({ confirmed: 2, failed: 0 });
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG, "k1", KB_BUCKET);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(ORG, "k2", KB_BUCKET);
    expect(mockPurgeMarks.map((m) => m.status)).toEqual(["confirmed", "confirmed"]);
  });

  it("bites: an object-store failure is recorded as failed and does not throw — the row survives for the sweep", async () => {
    const storage = {
      deleteFileIfPresent: jest
        .fn()
        .mockRejectedValueOnce(new Error("R2 503"))
        .mockResolvedValueOnce(true),
    };

    const result = await attemptPageAttachmentPurge(
      {} as never,
      storage,
      ORG,
      ["k1", "k2"],
      KB_BUCKET,
    );

    expect(result).toEqual({ confirmed: 1, failed: 1 });
    expect(mockPurgeMarks.map((m) => m.status)).toEqual(["failed", "confirmed"]);
    expect(mockPurgeMarks[0]?.failedReason).toContain("R2 503");
  });

  it("touches the object store not at all when there is nothing to purge", async () => {
    const storage = { deleteFileIfPresent: jest.fn() };
    await expect(
      attemptPageAttachmentPurge({} as never, storage, ORG, [], KB_BUCKET),
    ).resolves.toEqual({
      confirmed: 0,
      failed: 0,
    });
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalled();
    expect(mockPurgeMarks).toEqual([]);
  });
});
