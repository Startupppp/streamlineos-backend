import { sql } from "drizzle-orm";
import { kbPages } from "../../../db/schema";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

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
    mockCalls.push(`record:${ids.join(",")}`);
    if (mockRecordThrows) throw new Error("write-ahead failed");
    return ["kb-media/org-1/a.webp"];
  }),
  attemptPageAttachmentPurge: jest.fn(async () => {
    mockCalls.push("attempt");
    return { confirmed: 1, failed: 0 };
  }),
  purgeOrphanedKbMedia: jest.fn(async () => {
    mockCalls.push("orphans");
    return mockOrphanCount;
  }),
}));

let mockCalls: string[] = [];
let mockRecordThrows = false;
let mockOrphanCount = 0;

import { KbPageTrashService } from "./kb-page-trash.service";

const ORG = "org-1";

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: ORG,
    isOrgOwner: false,
    role: "member",
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  } as CurrentUserContext;
}

function thenable<T>(rows: T, extra: Record<string, unknown> = {}) {
  return Object.assign(Promise.resolve(rows), extra);
}

function makeTreeDb(options: {
  trashedIds?: number[];
  trashedBatches?: number[][];
  expiredBatches?: number[][];
  subtreeIds?: number[];
}) {
  const selectResults: Array<Array<{ id: number }>> = [];
  if (options.trashedIds) selectResults.push(options.trashedIds.map((id) => ({ id })));
  for (const batch of options.trashedBatches ?? []) selectResults.push(batch.map((id) => ({ id })));
  for (const batch of options.expiredBatches ?? []) selectResults.push(batch.map((id) => ({ id })));

  let selectIndex = 0;
  const select = jest.fn(() => ({
    from: jest.fn(() => ({
      where: jest.fn(() => {
        const rows = selectResults[selectIndex++] ?? [];
        return thenable(rows, {
          orderBy: jest.fn(() => ({ limit: jest.fn(() => thenable(rows)) })),
        });
      }),
    })),
  }));

  const deleteFrom = jest.fn((table: unknown) => ({
    where: jest.fn(() => {
      if (table === kbPages) mockCalls.push("delete");
      return thenable([], { returning: jest.fn(() => thenable([{ id: 1 }])) });
    }),
  }));

  const tx = {
    execute: jest.fn().mockResolvedValue((options.subtreeIds ?? []).map((id) => ({ id }))),
    delete: deleteFrom,
  };

  return {
    select,
    delete: deleteFrom,
    insert: jest.fn(() => ({
      values: jest.fn(() => ({ onConflictDoNothing: async () => undefined })),
    })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: async () => undefined })),
    })),
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue({ id: 10, title: "P" }) },
      kbPagePurgeLedger: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
}

const makeAudit = () => ({ log: jest.fn() });
const makeStorage = () => ({ deleteFileIfPresent: jest.fn().mockResolvedValue(true) });
const KB_BUCKET = "kb-files";
const makeConfig = () => ({ R2_KB_BUCKET_NAME: KB_BUCKET });
const makeAuth = () => ({
  visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  assertPageAccess: jest.fn().mockResolvedValue({ orgId: "o1", pageId: 1, action: "manage", via: "admin" }),
});
const makeTreeMock = () => ({ restore: jest.fn().mockResolvedValue({ id: 10 }) });

describe("KbPageTrashService — every path that cascades kb_page_attachments records the objects first", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCalls = [];
    mockRecordThrows = false;
    mockOrphanCount = 0;
  });

  function makeTrash(db: unknown, audit: unknown = makeAudit()) {
    return new KbPageTrashService(
      db as never,
      audit as never,
      makeStorage() as never,
      makeConfig() as never,
      makeAuth() as never,
      makeTreeMock() as never,
    );
  }

  it("emptyTrash records the purge before it deletes the pages", async () => {
    const db = makeTreeDb({ trashedIds: [10, 11] });
    const svc = new KbPageTrashService(
      db as never,
      makeAudit() as never,
      makeStorage() as never,
      makeConfig() as never,
      makeAuth() as never,
      makeTreeMock() as never,
    );

    await svc.emptyTrash(makeUser());

    expect(mockCalls).toEqual(["record:10,11", "delete", "attempt"]);
  });

  it("purgeExpired records the purge before it deletes each batch, then sweeps page-less media", async () => {
    const db = makeTreeDb({ expiredBatches: [[20, 21], []] });
    const svc = makeTrash(db);

    await svc.purgeExpired(ORG, new Date("2026-01-01"));

    expect(mockCalls).toEqual(["record:20,21", "delete", "attempt", "orphans"]);
  });

  it("purgeExpired sweeps page-less media even when nothing expired — that is the only path that reaches it", async () => {
    const db = makeTreeDb({ expiredBatches: [[]] });
    const audit = makeAudit();
    mockOrphanCount = 3;
    const svc = makeTrash(db, audit);

    await expect(svc.purgeExpired(ORG, new Date("2026-01-01"))).resolves.toBe(0);

    expect(mockCalls).toEqual(["orphans"]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "kb.media.orphan_purged",
        metadata: { purgedCount: 3 },
      }),
    );
  });

  it("emptyTrash keeps asking while a batch comes back full, and stops on a short one", async () => {
    const full = Array.from({ length: 500 }, (_, i) => i + 1);
    const db = makeTreeDb({ trashedBatches: [full, [777]] });
    const svc = makeTrash(db);

    await svc.emptyTrash(makeUser());

    expect(db.select).toHaveBeenCalledTimes(2);
    expect(mockCalls).toEqual([
      `record:${full.join(",")}`,
      "delete",
      "attempt",
      "record:777",
      "delete",
      "attempt",
    ]);
  });

  it("hardDelete records the purge for the whole subtree before it deletes the pages", async () => {
    const db = makeTreeDb({ subtreeIds: [10, 12, 13] });
    const svc = new KbPageTrashService(
      db as never,
      makeAudit() as never,
      makeStorage() as never,
      makeConfig() as never,
      makeAuth() as never,
      makeTreeMock() as never,
    );

    await svc.hardDelete(makeUser(), 10);

    expect(mockCalls).toEqual(["record:10,12,13", "delete", "attempt"]);
  });

  it("bites: when the write-ahead record fails, no page is deleted", async () => {
    mockRecordThrows = true;
    const db = makeTreeDb({ trashedIds: [10] });
    const svc = new KbPageTrashService(
      db as never,
      makeAudit() as never,
      makeStorage() as never,
      makeConfig() as never,
      makeAuth() as never,
      makeTreeMock() as never,
    );

    await expect(svc.emptyTrash(makeUser())).rejects.toThrow("write-ahead failed");
    expect(mockCalls).toEqual(["record:10"]);
  });

  it("empties nothing and records nothing when the trash is empty", async () => {
    const db = makeTreeDb({ trashedIds: [] });
    const svc = new KbPageTrashService(
      db as never,
      makeAudit() as never,
      makeStorage() as never,
      makeConfig() as never,
      makeAuth() as never,
      makeTreeMock() as never,
    );

    await expect(svc.emptyTrash(makeUser())).resolves.toEqual({ purgedCount: 0 });
    expect(mockCalls).toEqual([]);
  });
});
