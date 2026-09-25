import { sql } from "drizzle-orm";
import { kbPages } from "../../../db/schema";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  ...jest.requireActual("../../../common/tenant/run-in-tenant-transaction"),
  runInNewTenantTransaction: async (
    db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(db),
}));

jest.mock("./kb-page-attachment-purge", () => ({
  KB_PAGE_ATTACHMENT_PURGE_PURPOSE: "kb:page:purge",
  recordPageAttachmentPurge: jest.fn(async (_db: unknown, _org: string, ids: number[]) => {
    mockRecordedBatches.push(ids.length);
    return [];
  }),
  attemptPageAttachmentPurge: jest.fn(async () => ({ confirmed: 0, failed: 0 })),
  purgeOrphanedKbMedia: jest.fn(async () => 0),
}));

const auth = {
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-1", pageId: 1, action: "view", via: "admin" }),
};

const mockRecordedBatches: number[] = [];

import { KbPageTrashService } from "./kb-page-trash.service";

const ORG = "org-drain";
const BATCH = 500;

function makeDb(batches: number[][]) {
  const deletedFrom: string[] = [];
  let call = 0;
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          orderBy: jest.fn(() => ({
            limit: jest.fn(async () => (batches[call++] ?? []).map((id) => ({ id }))),
          })),
        })),
      })),
    })),
    delete: jest.fn((table: unknown) => {
      deletedFrom.push(table === kbPages ? "kb_pages" : "unexpected_table");
      return { where: jest.fn().mockResolvedValue([]) };
    }),
    insert: jest.fn(() => ({
      values: jest.fn(() => ({ onConflictDoNothing: async () => undefined })),
    })),
    query: {
      kbPagePurgeLedger: {
        findFirst: jest.fn().mockResolvedValue({ status: "completed" }),
      },
    },
  };
  return { db, deletedFrom, selects: () => call };
}

function makeTree(db: unknown) {
  return new KbPageTrashService(
    db as never,
    { log: jest.fn() } as never,
    { deleteFileIfPresent: jest.fn().mockResolvedValue(true) } as never,
    { R2_KB_BUCKET_NAME: "kb-files" } as never,
    auth as never,
    { restore: jest.fn().mockResolvedValue({ id: 1 }) } as never,
    { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

beforeEach(() => {
  mockRecordedBatches.length = 0;
});

describe("purgeExpired drains rather than stopping at the batch cap", () => {
  const full = Array.from({ length: BATCH }, (_v, i) => i + 1);

  it("keeps going after a batch that came back full, and purges every expired page", async () => {
    const { db, selects } = makeDb([full, [777], []]);

    const purged = await makeTree(db).purgeExpired(ORG, new Date("2026-01-01"));

    expect(purged).toBe(BATCH + 1);
    expect(mockRecordedBatches).toEqual([BATCH, 1]);
    expect(selects()).toBe(3);
  });

  it("stops on the first empty batch, so an empty trash costs one query", async () => {
    const { db, deletedFrom, selects } = makeDb([[]]);

    const purged = await makeTree(db).purgeExpired(ORG, new Date("2026-01-01"));

    expect(purged).toBe(0);
    expect(selects()).toBe(1);
    expect(deletedFrom).toEqual([]);
  });

  it("deletes from kb_pages on every iteration it takes", async () => {
    const { db, deletedFrom } = makeDb([full, [777], []]);

    await makeTree(db).purgeExpired(ORG, new Date("2026-01-01"));

    expect(deletedFrom).toEqual(["kb_pages", "kb_pages"]);
  });

  it("BITE: a single capped pass would report the cap and stop, which these numbers exclude", async () => {
    const { db } = makeDb([full, [777], []]);

    const purged = await makeTree(db).purgeExpired(ORG, new Date("2026-01-01"));

    expect(purged).not.toBe(BATCH);
    expect(mockRecordedBatches.length).toBeGreaterThan(1);
  });
});
