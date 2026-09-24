jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(mockTenantTx),
  ),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

interface PurgeMark {
  status: string;
  confirmedAt?: Date;
  lastAttemptedAt: Date;
  failedReason: string | null;
}

interface PendingPurgeRow {
  orgId: string;
  storageKey: string;
  purpose: string;
  bucket: string;
  status: string;
}

const mockPurgeMarks: PurgeMark[] = [];
const mockInsertedBatches: PendingPurgeRow[][] = [];
const mockInsertValues = jest.fn();
const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockUpdateSet = jest.fn((mark: PurgeMark) => {
  mockPurgeMarks.push(mark);
  return { where: mockUpdateWhere };
});

const mockTenantTx = {
  insert: jest.fn(() => ({
    values: jest.fn((rows: PendingPurgeRow[]) => {
      mockInsertedBatches.push(rows);
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
const CHUNK = 500;

interface AttachmentRow {
  id: number;
  fileKey: string;
}

interface SelectChain {
  orderBy: () => SelectChain;
  limit: (n: number) => Promise<AttachmentRow[]>;
}

const dialect = new PgDialect();

/**
 * The keyset cursor is read off the rendered predicate rather than assumed:
 * `gt(id, afterId)` is the last bound parameter, so a mock that answered the
 * same page forever — which is what the previous one did — cannot exist here.
 */
function cursorOf(condition: SQL | undefined): number {
  if (condition === undefined) throw new Error("the purge select ran with no WHERE clause");
  const { params } = dialect.sqlToQuery(condition);
  return Number(params[params.length - 1]);
}

function attachmentDb(rows: AttachmentRow[]) {
  const cursors: number[] = [];
  const pageSizes: number[] = [];
  const where = jest.fn((condition: SQL | undefined) => {
    const afterId = cursorOf(condition);
    cursors.push(afterId);
    if (cursors.length > 12)
      throw new Error(`keyset loop never advanced past ${afterId} — afterId is not being moved`);
    const remaining = rows.filter((r) => r.id > afterId);
    const chain: SelectChain = {
      orderBy: () => chain,
      limit: (n: number) => {
        pageSizes.push(n);
        return Promise.resolve(remaining.slice(0, n));
      },
    };
    return chain;
  });
  return {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where })) })),
    where,
    cursors,
    pageSizes,
  };
}

function keyRows(count: number, prefix: string, firstId = 1): AttachmentRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    fileKey: `${prefix}/${firstId + i}.webp`,
  }));
}

function insertedRows(call: number): PendingPurgeRow[] {
  const batch = mockInsertedBatches[call];
  if (batch === undefined) throw new Error(`no storage_pending_purge insert at call ${call}`);
  return batch;
}

function resetPurgeCaptures(): void {
  jest.clearAllMocks();
  mockInsertedBatches.length = 0;
  mockPurgeMarks.length = 0;
}

describe("recordPageAttachmentPurge — the write-ahead record is opened before the row is cascaded away", () => {
  beforeEach(resetPurgeCaptures);

  it("opens one pending storage_pending_purge row per distinct file key, in the KB bucket", async () => {
    const db = attachmentDb([
      { id: 1, fileKey: "kb-media/org-1/a.webp" },
      { id: 2, fileKey: "kb-media/org-1/b.pdf" },
      { id: 3, fileKey: "kb-media/org-1/a.webp" },
    ]);

    const keys = await recordPageAttachmentPurge(db as never, ORG, [10, 11]);

    expect(keys).toEqual(["kb-media/org-1/a.webp", "kb-media/org-1/b.pdf"]);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(insertedRows(0)).toEqual([
      {
        orgId: ORG,
        storageKey: "kb-media/org-1/a.webp",
        purpose: KB_PAGE_ATTACHMENT_PURGE_PURPOSE,
        bucket: "kb",
        status: "pending",
      },
      {
        orgId: ORG,
        storageKey: "kb-media/org-1/b.pdf",
        purpose: KB_PAGE_ATTACHMENT_PURGE_PURPOSE,
        bucket: "kb",
        status: "pending",
      },
    ]);
  });

  it("walks the cursor across three batches and chunks the insert to match", async () => {
    const db = attachmentDb(keyRows(1_200, "kb-media/org-1"));

    const keys = await recordPageAttachmentPurge(db as never, ORG, [10]);

    expect(db.where).toHaveBeenCalledTimes(3);
    expect(db.cursors).toEqual([0, 500, 1_000]);
    expect(db.pageSizes).toEqual([CHUNK, CHUNK, CHUNK]);
    expect(keys).toHaveLength(1_200);
    expect(keys[0]).toBe("kb-media/org-1/1.webp");
    expect(keys[1_199]).toBe("kb-media/org-1/1200.webp");
    expect(mockInsertValues).toHaveBeenCalledTimes(3);
    expect(insertedRows(0)).toHaveLength(CHUNK);
    expect(insertedRows(1)).toHaveLength(CHUNK);
    expect(insertedRows(2)).toHaveLength(200);
    expect(insertedRows(1)[0].storageKey).toBe("kb-media/org-1/501.webp");
    expect(insertedRows(2)[199].storageKey).toBe("kb-media/org-1/1200.webp");
  });

  it("bites: the cursor each batch requests is the last id the previous batch returned", async () => {
    const db = attachmentDb(keyRows(1_100, "kb-media/org-1"));

    await recordPageAttachmentPurge(db as never, ORG, [10]);

    expect(db.cursors[0]).toBe(0);
    expect(db.cursors[1]).toBe(500);
    expect(db.cursors[2]).toBe(1_000);
    for (let i = 1; i < db.cursors.length; i++)
      expect(db.cursors[i]).toBeGreaterThan(db.cursors[i - 1]);
  });

  it("deduplicates a file key that two attachments share across batch boundaries", async () => {
    const rows = keyRows(CHUNK, "kb-media/org-1");
    const shared = rows[0];
    if (!shared) throw new Error("fixture is empty");
    rows.push({ id: 900, fileKey: shared.fileKey });
    rows.push({ id: 901, fileKey: "kb-media/org-1/unique.webp" });
    const db = attachmentDb(rows);

    const keys = await recordPageAttachmentPurge(db as never, ORG, [10]);

    expect(db.where).toHaveBeenCalledTimes(2);
    expect(keys).toHaveLength(CHUNK + 1);
    expect(keys.filter((k) => k === shared.fileKey)).toHaveLength(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(2);
    expect(insertedRows(1)).toHaveLength(1);
  });

  it("writes nothing when the page set carries no attachments", async () => {
    const db = attachmentDb([]);
    await expect(recordPageAttachmentPurge(db as never, ORG, [10])).resolves.toEqual([]);
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("reads no attachment rows at all for an empty page set", async () => {
    const db = attachmentDb([{ id: 1, fileKey: "k" }]);
    await expect(recordPageAttachmentPurge(db as never, ORG, [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("bites: a failed write-ahead insert propagates, so the caller cannot go on to delete the page", async () => {
    const db = attachmentDb([{ id: 1, fileKey: "kb-media/org-1/a.webp" }]);
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
  beforeEach(resetPurgeCaptures);

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
