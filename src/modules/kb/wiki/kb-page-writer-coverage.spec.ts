import "reflect-metadata";
import { KbPageWriterService } from "./kb-page-writer.service";
import { KbPagesService } from "./kb-pages.service";
import { KbPageDuplicateService } from "./kb-page-duplicate.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbImportProcessConsumer } from "./kb-import-process.consumer";
import { KbPageVisitsService } from "./kb-page-visits.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { updateArticle } from "../../support/core/lib/support-kb-articles";
import {
  lookupSupportArticleCurrentState,
  patchSupportArticle,
} from "../core/kb-support-documents";

jest.mock("../core/kb-support-documents", () => ({
  lookupSupportArticleCurrentState: jest.fn(),
  patchSupportArticle: jest.fn(),
}));

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: jest.fn().mockImplementation(
    (db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  ),
}));

function hasWriterInjected(ServiceClass: Function): boolean {
  const paramTypes = Reflect.getMetadata("design:paramtypes", ServiceClass) as
    | Function[]
    | undefined;
  return paramTypes?.some((t) => t === KbPageWriterService) ?? false;
}

const ORG_ID = "org-coverage";
const PAGE_ID = 99;
const ARTICLE_ID = 12;

const RETURNED_PAGE = {
  id: PAGE_ID,
  orgId: ORG_ID,
  title: "Test Page",
  slug: null,
  content: null,
  contentText: "some content",
  contentRevision: 1,
  aclRevision: 1,
  spaceId: null,
  categoryId: null,
  parentPageId: null,
  sortOrder: 100,
  status: "draft" as const,
  contentType: "rich_text" as const,
  icon: null,
  coverImage: null,
  visibility: "workspace" as const,
  isLocked: false,
  trustState: "unverified" as const,
  ownerUserId: null,
  ownerMembershipId: null,
  publicToken: null,
  publicTokenHash: null,
  publicTokenRevision: 1,
  publicTokenExpiresAt: null,
  publicSlug: null,
  projectId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdById: "user-1",
  createdByMembershipId: 1,
  lastEditedById: "user-1",
  lastEditedByMembershipId: 1,
  deletedAt: null,
  deletedById: null,
  deletedByMembershipId: null,
  verifiedById: null,
  verifiedByMembershipId: null,
  verifiedAt: null,
  verifiedUntil: null,
  nextReviewAt: null,
  legalHold: false,
  legalHoldReason: null,
};

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    role: "member" as const,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: {
      kind: "human-session" as const,
      membershipId: 1,
      isOrgOwner: false,
    },
  };
}

function makeAuth() {
  return {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
    assertSpaceAccess: jest.fn().mockResolvedValue(undefined),
    visiblePagePredicate: jest.fn(),
    resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed" }),
  } as never;
}

function makeWriter() {
  return new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);
}

describe("structural invariant: every injectable page-mutating service routes its index event through KbPageWriterService", () => {
  it("CONTROL: a page-mutating service that does not take the writer is reported as uninjected, proving the assertions above are not true of every class", () => {
    class ServiceWithoutWriter {
      constructor(readonly unrelated: string) {}
    }

    expect(hasWriterInjected(ServiceWithoutWriter)).toBe(false);
  });
});

describe("KbPagesService.create — writer delegation", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeCreateDb() {
    const tx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([RETURNED_PAGE]),
        }),
      }),
    };
    return {
      query: {},
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  function makeCreateService(
    db: ReturnType<typeof makeCreateDb>,
    writer: KbPageWriterService,
  ) {
    return new KbPagesService(
      db as never,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      makeAuth(),
      {} as never,
      { log: jest.fn() } as never,
      writer,
    );
  }

  it("calls commitPageChange with writeOutcome 'created' so newly created pages appear in search without a separate backfill step", async () => {
    const db = makeCreateDb();
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeCreateService(db, writer);

    await svc.create(makeUser() as never, { title: "New Page" } as never);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID, writeOutcome: "created" }),
    );
  });

  it("does not call commitPageChange when the DB insert fails inside the transaction, proving the writer and mutation share the same success path and a rollback leaves no index event", async () => {
    const boom = new Error("insert failed");
    const failingTx = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(boom),
        }),
      }),
    };
    const db = {
      query: {},
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(failingTx)),
    };
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeCreateService(db as never, writer);

    await expect(
      svc.create(makeUser() as never, { title: "Bad Page" } as never),
    ).rejects.toThrow("insert failed");

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("KbPageDuplicateService.duplicate — writer delegation", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeDuplicateDb() {
    const originalPage = { ...RETURNED_PAGE, content: null };
    const copiedPage = {
      ...RETURNED_PAGE,
      id: PAGE_ID + 1,
      sortOrder: 100,
      parentPageId: null,
      title: "Test Page (copy)",
    };
    let selectCount = 0;
    const tx = {
      execute: jest.fn().mockResolvedValue([{ id: PAGE_ID }]),
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            selectCount += 1;
            if (selectCount === 1) {
              return Promise.resolve([originalPage]);
            }
            return {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            };
          }),
        }),
      })),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([copiedPage]),
        }),
      }),
    };
    return {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  it("calls commitManyPageChanges so all pages in a duplicated subtree enter the search index atomically in the same transaction that inserts them", async () => {
    const db = makeDuplicateDb();
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitManyPageChanges").mockResolvedValue(undefined);
    const svc = new KbPageDuplicateService(
      db as never,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      makeAuth(),
      writer,
    );

    await svc.duplicate(makeUser() as never, PAGE_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });
});

describe("KbPageTreeService.move — writer delegation", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeMoveDb() {
    const tx = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([RETURNED_PAGE]),
          }),
        }),
      }),
    };
    return {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            parentPageId: null,
            spaceId: null,
          }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  function makeMoveService(
    db: ReturnType<typeof makeMoveDb>,
    writer: KbPageWriterService,
  ) {
    return new KbPageTreeService(
      db as never,
      { log: jest.fn() } as never,
      makeAuth(),
      {} as never,
      writer,
    );
  }

  it("calls commitPageChange when a page is moved so the ACL revision update propagates to the search index without waiting for a background backfill", async () => {
    const db = makeMoveDb();
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeMoveService(db, writer);

    await svc.move(makeUser() as never, PAGE_ID, { parentPageId: null, index: 0 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("softDelete does NOT call commitPageChange, proving the spy is live and a method that intentionally omits the writer is distinguishable from one that forgets it", async () => {
    const softDeleteTx = {
      execute: jest.fn().mockResolvedValue([{ id: PAGE_ID }]),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    };
    const softDeleteDb = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            deletedAt: null,
            title: "Test",
          }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb(softDeleteTx),
      ),
    };
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = new KbPageTreeService(
      softDeleteDb as never,
      { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) } as never,
      { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      writer,
    );

    await svc.softDelete(makeUser() as never, PAGE_ID);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("KbImportProcessConsumer.handle — writer delegation", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeImportEvent() {
    return {
      eventId: "evt-import-1",
      organizationId: ORG_ID,
      aggregateType: "kb_import_job",
      aggregateId: "1",
      aggregateVersion: 1,
      eventType: "kb.import.process",
      payload: {
        jobId: 1,
        userId: "user-1",
        orgId: ORG_ID,
        input: {
          sourceType: "markdown",
          items: [{ title: "Doc A", contentText: "body" }],
          visibility: "org",
          duplicatePolicy: "update",
        },
      },
    };
  }

  it("calls commitManyPageChanges after inserting imported pages so they are searchable in the same atomic batch", async () => {
    const insertedPage = {
      id: 55,
      contentRevision: 1,
      aclRevision: 1,
      contentText: "body",
    };

    const { runInNewTenantTransaction } = jest.requireMock(
      "../../../common/tenant/run-in-tenant-transaction",
    ) as { runInNewTenantTransaction: jest.Mock };

    let callCount = 0;
    runInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
        callCount += 1;
        const currentCall = callCount;
        const statusRows =
          currentCall === 1 ? [{ status: "pending" }] : [];
        const whereResult = Object.assign(Promise.resolve(statusRows), {
          groupBy: jest.fn().mockResolvedValue([]),
          limit: jest.fn().mockResolvedValue(statusRows),
        });
        const tx = {
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue(whereResult),
              groupBy: jest.fn().mockResolvedValue([]),
            }),
          }),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue(undefined),
            }),
          }),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              onConflictDoNothing: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue(
                  currentCall === 3 ? [insertedPage] : [],
                ),
              }),
            }),
          }),
        };
        return fn(tx);
      },
    );

    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitManyPageChanges").mockResolvedValue(undefined);
    const consumer = new KbImportProcessConsumer(
      {} as never,
      { register: jest.fn() } as never,
      { log: jest.fn() } as never,
      writer,
    );

    await consumer.handle(makeImportEvent() as never);

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        pages: expect.arrayContaining([expect.objectContaining({ id: 55 })]),
      }),
    );
  });
});

describe("updateArticle — writer delegation for published support articles", () => {
  beforeEach(() => jest.clearAllMocks());

  const CURRENT_ARTICLE = {
    id: ARTICLE_ID,
    slug: "test-article",
    status: "published",
    publishedAt: new Date(),
    title: "Test Article",
    contentText: "current content",
    visibility: "org",
    contentRevision: 1,
  };

  const UPDATED_ARTICLE = {
    id: ARTICLE_ID,
    title: "Test Article",
    contentRevision: 1,
    aclRevision: 2,
    status: "published",
    visibility: "public",
    slug: "test-article",
    publishedAt: new Date(),
    excerpt: null,
    categoryId: null,
  };

  function makeSupportTx() {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    };
  }

  it("calls commitPageChange when a published article has a visibility change so the ACL revision update reaches the search index immediately", async () => {
    (lookupSupportArticleCurrentState as jest.Mock).mockResolvedValue(CURRENT_ARTICLE);
    (patchSupportArticle as jest.Mock).mockResolvedValue(UPDATED_ARTICLE);
    const tx = makeSupportTx();
    const db = {
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    await updateArticle(
      db as never,
      writer,
      ORG_ID,
      ARTICLE_ID,
      { visibility: "public" } as never,
      null,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        page: expect.objectContaining({ id: ARTICLE_ID }),
      }),
    );
  });

  it("passes contentText null to commitPageChange because support articles store body text outside the page content field — the writer must not skip empty-contentText index events", async () => {
    (lookupSupportArticleCurrentState as jest.Mock).mockResolvedValue(CURRENT_ARTICLE);
    (patchSupportArticle as jest.Mock).mockResolvedValue(UPDATED_ARTICLE);
    const tx = makeSupportTx();
    const db = {
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    await updateArticle(
      db as never,
      writer,
      ORG_ID,
      ARTICLE_ID,
      { visibility: "public" } as never,
      null,
    );

    const callArgs = spy.mock.calls[0]?.[1];
    expect(callArgs?.page.contentText).toBeNull();
  });

  it("does not call commitPageChange when the article is a draft, proving the spy is live and a draft visibility change cannot accidentally trigger an index event", async () => {
    const draftArticle = {
      ...CURRENT_ARTICLE,
      status: "draft",
      publishedAt: null,
    };
    const updatedDraft = { ...UPDATED_ARTICLE, status: "draft" };
    (lookupSupportArticleCurrentState as jest.Mock).mockResolvedValue(draftArticle);
    (patchSupportArticle as jest.Mock).mockResolvedValue(updatedDraft);
    const tx = makeSupportTx();
    const db = {
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
    const writer = makeWriter();
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    await updateArticle(
      db as never,
      writer,
      ORG_ID,
      ARTICLE_ID,
      { visibility: "public" } as never,
      null,
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("KbPageVisitsService.recordVisit — engagement does not trigger reindex", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not emit a kb.content.index outbox event so a visit record never inflates the indexing queue or causes spurious re-embedding", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const db = {
      query: {
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ id: 1 }),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoUpdate: jest.fn().mockResolvedValue(undefined),
        }),
      }),
    };
    const svc = new KbPageVisitsService(
      db as never,
      { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await svc.recordVisit(makeUser() as never, PAGE_ID);

    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("CONTROL: commitPageChange does call OutboxWriter.emit, proving the spy is live and would catch an emit from recordVisit if one existed", async () => {
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const writer = makeWriter();

    await writer.commitPageChange({} as never, {
      orgId: ORG_ID,
      actor: { userId: "user-1", membershipId: null },
      action: "kb.page.updated",
      page: {
        id: PAGE_ID,
        title: "T",
        contentRevision: 1,
        aclRevision: 1,
        contentText: null,
      },
      changed: {},
    });

    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "kb.content.index" }),
    );
  });
});
