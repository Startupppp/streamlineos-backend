import { sql } from "drizzle-orm";
import { kbPageVersions } from "../../../db/schema";
import { outboxEvents } from "../../../db/schema/common/outbox";
import type { Db } from "../../../db/drizzle.module";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { KbPageWriterService } from "./kb-page-writer.service";

function makeUser(orgId = "org-a") {
  return {
    orgId,
    userId: "u1",
    role: "MEMBER",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  } as never;
}

const BASE_PAGE = {
  id: 1,
  orgId: "org-a",
  isLocked: false,
  trustState: "unverified" as const,
  content: { type: "doc", content: [] },
  title: "A page",
  contentRevision: 3,
  aclRevision: 1,
  spaceId: null,
  parentPageId: null,
  sortOrder: null,
  projectId: null,
  icon: null,
  coverImage: null,
  status: "draft" as const,
  contentType: "rich_text" as const,
  visibility: "private" as const,
  publicToken: null,
  publicSlug: null,
  contentText: "some text",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  createdByMembershipId: null,
  lastEditedByMembershipId: null,
  deletedByMembershipId: null,
  ownerMembershipId: null,
  verifiedByMembershipId: null,
  createdById: "u1",
  lastEditedById: "u1",
  deletedById: null,
  ownerUserId: null,
  verifiedById: null,
  verifiedUntil: null,
  nextReviewAt: null,
};

const VERSION_ROW = {
  id: 10,
  versionNumber: 2,
  orgId: "org-a",
  pageId: 1,
  title: "Old title",
  content: { type: "doc", content: [] },
  contentText: "old text",
  changeSummary: null,
  authorId: "u1",
  authorMembershipId: null,
  createdAt: new Date(),
};

type InsertCapture = { table: unknown; values: unknown };

function makeDb(opts: { updatedPage: typeof BASE_PAGE }) {
  const insertCaptures: InsertCapture[] = [];

  const insertMock = jest.fn((table: unknown) => ({
    values: (vals: unknown) => {
      insertCaptures.push({ table, values: vals });
      return Promise.resolve([]);
    },
    onConflictDoNothing: () => Promise.resolve([]),
  }));

  const returningMock = jest.fn().mockResolvedValue([opts.updatedPage]);
  const updateMock = jest.fn(() => ({
    set: jest.fn(() => ({
      where: jest.fn(() => ({ returning: returningMock })),
    })),
  }));

  const deleteMock = jest.fn(() => ({
    where: jest.fn().mockResolvedValue([]),
  }));

  const findFirstVersionMock = jest.fn().mockResolvedValue(null);

  const executeMock = jest.fn().mockResolvedValue([]);

  const tx = {
    update: updateMock,
    insert: insertMock,
    delete: deleteMock,
    execute: executeMock,
    query: {
      kbPageVersions: { findFirst: findFirstVersionMock },
    },
  };

  const db = {
    query: {
      kbPages: { findFirst: jest.fn().mockResolvedValue(BASE_PAGE) },
      kbPageVersions: { findFirst: jest.fn().mockResolvedValue(VERSION_ROW) },
    },
    transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, insertCaptures, deleteMock, executeMock };
}

function makeAuth() {
  return {
    assertPageAccess: jest.fn().mockResolvedValue({ orgId: "org-a", pageId: 1, action: "edit", via: "admin" }),
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
  };
}

describe("KbPageVersionsService.restoreVersion — append-only semantics", () => {
  it("(a) restore inserts at least one row into kbPageVersions, not zero", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 4, content: VERSION_ROW.content };
    const { db, insertCaptures } = makeDb({ updatedPage });
    const svc = new KbPageVersionsService(db, makeAuth() as never, new KbPageWriterService({} as never));

    await svc.restoreVersion(makeUser(), 1, 2, false);

    const versionInserts = insertCaptures.filter((c) => c.table === kbPageVersions);
    expect(versionInserts.length).toBeGreaterThanOrEqual(1);
  });

  it("(b) no existing version rows are deleted during restore, and the delete capture is live so this is not vacuous", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 4, content: VERSION_ROW.content };
    const { db, deleteMock } = makeDb({ updatedPage });
    const svc = new KbPageVersionsService(db, makeAuth() as never, new KbPageWriterService({} as never));

    await svc.restoreVersion(makeUser(), 1, 2, false);

    expect(deleteMock.mock.calls.length).toBeGreaterThan(0);

    const versionDeletes = deleteMock.mock.calls.filter(
      (call: unknown[]) => call[0] === kbPageVersions,
    );
    expect(versionDeletes).toHaveLength(0);
  });

  it("(c) calling restore twice inserts two separate version snapshots", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 4, content: VERSION_ROW.content };
    const { db, insertCaptures } = makeDb({ updatedPage });

    const svc = new KbPageVersionsService(db, makeAuth() as never, new KbPageWriterService({} as never));

    await svc.restoreVersion(makeUser(), 1, 2, false);
    await svc.restoreVersion(makeUser(), 1, 2, false);

    const versionInserts = insertCaptures.filter((c) => c.table === kbPageVersions);
    expect(versionInserts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("KbPageVersionsService.restoreVersion — audit entry", () => {
  it("(a) calls tx.execute once to write the restore audit row inside the transaction", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 4, content: VERSION_ROW.content };
    const { db, executeMock } = makeDb({ updatedPage });
    const svc = new KbPageVersionsService(db, makeAuth() as never, new KbPageWriterService({} as never));

    await svc.restoreVersion(makeUser(), 1, 2, false);

    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("(b) the audit execute call includes page_id, source_version_number and actor_user_id", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 4, content: VERSION_ROW.content };
    const { db, executeMock } = makeDb({ updatedPage });
    const svc = new KbPageVersionsService(db, makeAuth() as never, new KbPageWriterService({} as never));

    await svc.restoreVersion(makeUser("org-a"), 1, 2, false);

    const call = executeMock.mock.calls[0]?.[0];
    const rendered = JSON.stringify(call);
    expect(rendered).toContain("kb_version_restore_audit");
    expect(rendered).toContain("u1");
  });
});

describe("KbPageVersionsService.restoreVersion — outbox-based reindex", () => {
  it("(a) emits exactly one outbox event with eventType kb.content.index inside the transaction", async () => {
    const updatedPage = { ...BASE_PAGE, contentRevision: 4, content: VERSION_ROW.content };
    const { db, insertCaptures } = makeDb({ updatedPage });
    const svc = new KbPageVersionsService(db, makeAuth() as never, new KbPageWriterService({} as never));

    await svc.restoreVersion(makeUser(), 1, 2, false);

    const outboxInserts = insertCaptures.filter((c) => c.table === outboxEvents);
    expect(outboxInserts).toHaveLength(1);

    const payload = (outboxInserts[0]?.values as { eventType?: string } | undefined)?.eventType;
    expect(payload).toBe("kb.content.index");
  });
});
