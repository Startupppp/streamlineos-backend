jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn(
    async (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
  ),
  runInTenantTransaction: jest.fn(
    async (_db: unknown, fn: (tx: unknown) => unknown, _opts: unknown) => fn(mockTx),
  ),
}));

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { kbPageAttachments } from "../../../db/schema";
import { storagePendingPurge } from "../../../db/schema/common/storage-pending-purge";

interface PendingPurgeRow {
  orgId: string;
  storageKey: string;
  purpose: string;
  bucket: string;
  status: string;
}

interface UpdateCall {
  table: unknown;
  values: Record<string, unknown>;
}

const mockInserted: PendingPurgeRow[][] = [];
const mockUpdates: UpdateCall[] = [];

const mockTx = {
  insert: jest.fn(() => ({
    values: jest.fn((rows: PendingPurgeRow[]) => {
      mockInserted.push(rows);
      return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
    }),
  })),
  update: jest.fn((table: unknown) => ({
    set: jest.fn((values: Record<string, unknown>) => {
      mockUpdates.push({ table, values });
      return { where: jest.fn().mockResolvedValue(undefined) };
    }),
  })),
};

import {
  purgeOrphanedKbMedia,
  KB_ORPHAN_MEDIA_PURGE_PURPOSE,
} from "./kb-page-attachment-purge";

const ORG = "org-1";
const KB_BUCKET = "kb-files";
const NOW = new Date("2026-09-09T00:00:00.000Z");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface AttachmentRow {
  id: number;
  fileKey: string;
}

interface AttachmentChain {
  orderBy: () => AttachmentChain;
  limit: (n: number) => Promise<AttachmentRow[]>;
}

const dialect = new PgDialect();

function paramsOf(condition: SQL | undefined): unknown[] {
  if (condition === undefined) throw new Error("the orphan select ran with no WHERE clause");
  return dialect.sqlToQuery(condition).params;
}

function orphanDb(options: {
  batches: AttachmentRow[][];
  coverKeys?: string[];
}) {
  const attachmentWheres: unknown[][] = [];
  const coverKeyLookups: string[][] = [];
  let batchIndex = 0;

  const attachmentSelect = () => ({
    from: jest.fn(() => ({
      where: jest.fn((condition: SQL | undefined) => {
        attachmentWheres.push(paramsOf(condition));
        const rows = options.batches[batchIndex] ?? [];
        batchIndex += 1;
        const chain: AttachmentChain = {
          orderBy: () => chain,
          limit: () => Promise.resolve(rows),
        };
        return chain;
      }),
    })),
  });

  const coverSelect = () => ({
    from: jest.fn(() => ({
      where: jest.fn((condition: SQL | undefined) => {
        const params = paramsOf(condition);
        coverKeyLookups.push(params.slice(1).map((p) => String(p)));
        const held = new Set(options.coverKeys ?? []);
        const rows = params
          .slice(1)
          .map((p) => String(p))
          .filter((key) => held.has(key))
          .map((coverKey) => ({ coverKey }));
        return { limit: jest.fn(() => Promise.resolve(rows)) };
      }),
    })),
  });

  const select = jest.fn((projection: Record<string, unknown>) =>
    "coverKey" in projection ? coverSelect() : attachmentSelect(),
  );

  return { select, attachmentWheres, coverKeyLookups };
}

function reset(): void {
  jest.clearAllMocks();
  mockInserted.length = 0;
  mockUpdates.length = 0;
}

describe("purgeOrphanedKbMedia — the only path that can ever reach a page_id IS NULL attachment", () => {
  beforeEach(reset);

  it("opens a KB-bucket write-ahead row, soft-deletes the attachment and deletes the object", async () => {
    const db = orphanDb({ batches: [[{ id: 7, fileKey: "kb-media/org-1/stray.webp" }]] });
    const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };

    const purged = await purgeOrphanedKbMedia(db as never, storage, ORG, NOW, KB_BUCKET);

    expect(purged).toBe(1);
    expect(mockInserted).toEqual([
      [
        {
          orgId: ORG,
          storageKey: "kb-media/org-1/stray.webp",
          purpose: KB_ORPHAN_MEDIA_PURGE_PURPOSE,
          bucket: "kb",
          status: "pending",
        },
      ],
    ]);
    const softDelete = mockUpdates.find((u) => u.table === kbPageAttachments);
    expect(softDelete?.values).toEqual({ deletedAt: NOW });
    expect(storage.deleteFileIfPresent).toHaveBeenCalledWith(
      ORG,
      "kb-media/org-1/stray.webp",
      KB_BUCKET,
    );
    expect(mockUpdates.some((u) => u.table === storagePendingPurge)).toBe(true);
  });

  it("bites: a key a page still holds as its cover is left untouched — no purge row, no delete", async () => {
    const db = orphanDb({
      batches: [
        [
          { id: 7, fileKey: "kb-media/org-1/cover.webp" },
          { id: 8, fileKey: "kb-media/org-1/stray.webp" },
        ],
      ],
      coverKeys: ["kb-media/org-1/cover.webp"],
    });
    const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };

    const purged = await purgeOrphanedKbMedia(db as never, storage, ORG, NOW, KB_BUCKET);

    expect(purged).toBe(1);
    expect(db.coverKeyLookups).toEqual([
      ["kb-media/org-1/cover.webp", "kb-media/org-1/stray.webp"],
    ]);
    expect(mockInserted[0]?.map((r) => r.storageKey)).toEqual(["kb-media/org-1/stray.webp"]);
    expect(storage.deleteFileIfPresent).toHaveBeenCalledTimes(1);
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalledWith(
      ORG,
      "kb-media/org-1/cover.webp",
      KB_BUCKET,
    );
  });

  it("bites: when every candidate is a live cover it writes nothing at all", async () => {
    const db = orphanDb({
      batches: [[{ id: 7, fileKey: "kb-media/org-1/cover.webp" }]],
      coverKeys: ["kb-media/org-1/cover.webp"],
    });
    const storage = { deleteFileIfPresent: jest.fn() };

    await expect(
      purgeOrphanedKbMedia(db as never, storage, ORG, NOW, KB_BUCKET),
    ).resolves.toBe(0);

    expect(mockInserted).toEqual([]);
    expect(mockUpdates).toEqual([]);
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });

  it("never considers a row younger than the thirty-day floor", async () => {
    const db = orphanDb({ batches: [[]] });
    const storage = { deleteFileIfPresent: jest.fn() };

    await purgeOrphanedKbMedia(db as never, storage, ORG, NOW, KB_BUCKET);

    const [params] = db.attachmentWheres;
    expect(params?.[0]).toBe(ORG);
    expect(new Date(String(params?.[1])).getTime()).toBe(NOW.getTime() - THIRTY_DAYS_MS);
    expect(params?.[2]).toBe(0);
  });

  it("walks the keyset cursor rather than reading every page-less row at once", async () => {
    const first = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      fileKey: `kb-media/org-1/${i + 1}.webp`,
    }));
    const db = orphanDb({ batches: [first, [{ id: 900, fileKey: "kb-media/org-1/900.webp" }]] });
    const storage = { deleteFileIfPresent: jest.fn().mockResolvedValue(true) };

    const purged = await purgeOrphanedKbMedia(db as never, storage, ORG, NOW, KB_BUCKET);

    expect(purged).toBe(501);
    expect(db.attachmentWheres).toHaveLength(2);
    expect(db.attachmentWheres[0]?.[2]).toBe(0);
    expect(db.attachmentWheres[1]?.[2]).toBe(500);
  });

  it("touches nothing when the organisation has no page-less media", async () => {
    const db = orphanDb({ batches: [[]] });
    const storage = { deleteFileIfPresent: jest.fn() };

    await expect(
      purgeOrphanedKbMedia(db as never, storage, ORG, NOW, KB_BUCKET),
    ).resolves.toBe(0);

    expect(db.coverKeyLookups).toEqual([]);
    expect(mockInserted).toEqual([]);
    expect(storage.deleteFileIfPresent).not.toHaveBeenCalled();
  });
});
