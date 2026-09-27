import "reflect-metadata";
import { sql } from "drizzle-orm";
import { KbPageStatusService } from "./kb-page-status.service";
import { KbPagePublicService } from "./kb-page-public.service";
import { KbPageVersionsService } from "./kb-page-versions.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageWriterService } from "./kb-page-writer.service";

const ORG_ID = "org-all-surfaces";
const PAGE_ID = 77;

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    role: "member" as const,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: false },
  };
}

const RETURNED_PAGE = {
  id: PAGE_ID,
  orgId: ORG_ID,
  title: "Test page",
  slug: null,
  content: null,
  contentText: "test content",
  contentRevision: 2,
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

function makeAuth(page = RETURNED_PAGE as unknown) {
  return {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
    assertSpaceAccess: jest.fn().mockResolvedValue(undefined),
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed" }),
  } as never;
}

function makeUpdateChain(returnRow = RETURNED_PAGE) {
  return jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([returnRow]),
      }),
    }),
  });
}

function protoMethods(cls: new (...args: never[]) => unknown): Set<string> {
  return new Set(
    Object.getOwnPropertyNames(cls.prototype).filter(
      (m) => m !== "constructor" && typeof (cls.prototype as Record<string, unknown>)[m] === "function",
    ),
  );
}

describe("KbPageStatusService — writer delegation for status transitions", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeStatusDb() {
    const tx = { update: makeUpdateChain() };
    return {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  function makeStatusService(db: ReturnType<typeof makeStatusDb>, writer: KbPageWriterService) {
    return new KbPageStatusService(
      db as never,
      {} as never,
      makeAuth(),
      writer,
    );
  }

  it("publish calls writer.commitPageChange so a published page is immediately visible in search and Ask", async () => {
    const db = makeStatusDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeStatusService(db, writer);

    await svc.publish(makeUser() as never, PAGE_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("archive calls writer.commitPageChange so an archived page status change propagates to the index", async () => {
    const db = makeStatusDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeStatusService(db, writer);

    await svc.archive(makeUser() as never, PAGE_ID);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("unarchive calls writer.commitPageChange so a restored page re-enters search without waiting for backfill", async () => {
    const db = makeStatusDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeStatusService(db, writer);

    await svc.unarchive(makeUser() as never, PAGE_ID);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("lock does NOT call writer.commitPageChange — proving the spy is live and a method that genuinely skips the writer is distinguishable from one that forgets it", async () => {
    const db = {
      query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }) } },
      update: makeUpdateChain(),
    };
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeStatusService(db as never, writer);

    await svc.lock(makeUser() as never, PAGE_ID, true);

    expect(spy).not.toHaveBeenCalled();
  });

  it("all public methods on KbPageStatusService are classified so a new method cannot slip through untested", () => {
    const WRITER_DELEGATING = new Set(["publish", "archive", "unarchive"]);
    const NOT_DELEGATING = new Set(["membershipId", "setStatus", "lock", "verify", "markStale"]);
    const all = protoMethods(KbPageStatusService);
    const unclassified = [...all].filter(
      (m) => !WRITER_DELEGATING.has(m) && !NOT_DELEGATING.has(m),
    );
    expect(unclassified).toHaveLength(0);
  });
});

describe("KbPagePublicService — writer delegation for visibility changes", () => {
  beforeEach(() => jest.clearAllMocks());

  function makePublicDb() {
    const tx = { update: makeUpdateChain() };
    return {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            createdById: "user-1",
            createdByMembershipId: 1,
            visibility: "workspace",
            publicToken: null,
          }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  function makePublicService(db: ReturnType<typeof makePublicDb>, writer: KbPageWriterService) {
    return new KbPagePublicService(
      db as never,
      makeAuth(),
      {} as never,
      writer,
    );
  }

  it("setVisibility calls writer.commitPageChange so ACL revision change in the index reflects the new audience immediately", async () => {
    const db = makePublicDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makePublicService(db, writer);

    await svc.setVisibility(makeUser() as never, PAGE_ID, "org", true);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("all public methods on KbPagePublicService are classified so a new method cannot slip through untested", () => {
    const WRITER_DELEGATING = new Set(["setVisibility"]);
    const NOT_DELEGATING = new Set([
      "membershipId",
      "search",
      "getPublicPage",
      "validatePublicAttachment",
    ]);
    const all = protoMethods(KbPagePublicService);
    const unclassified = [...all].filter(
      (m) => !WRITER_DELEGATING.has(m) && !NOT_DELEGATING.has(m),
    );
    expect(unclassified).toHaveLength(0);
  });
});

describe("KbPageVersionsService — writer delegation for version restore", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeVersionsDb() {
    const tx = {
      update: makeUpdateChain(),
      execute: jest.fn().mockResolvedValue([]),
    };
    return {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            isLocked: false,
            content: null,
            title: "Test",
            contentText: "text",
            orgId: ORG_ID,
            contentRevision: 1,
            aclRevision: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
        kbPageVersions: {
          findFirst: jest.fn().mockResolvedValue({
            id: 5,
            pageId: PAGE_ID,
            orgId: ORG_ID,
            versionNumber: 3,
            title: "version three",
            content: null,
            contentText: "version content",
          }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  function makeVersionsService(
    db: ReturnType<typeof makeVersionsDb>,
    writer: KbPageWriterService,
  ) {
    return new KbPageVersionsService(
      db as never,
      makeAuth(),
      writer,
    );
  }

  it("restoreVersion calls writer.commitPageChange so the restored content is immediately searchable without a manual backfill run", async () => {
    const db = makeVersionsDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeVersionsService(db, writer);

    await svc.restoreVersion(makeUser() as never, PAGE_ID, 3, false);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("listVersions does NOT call writer.commitPageChange — proving the spy is live and a read-only method is distinguishable from a write method that forgets the writer", async () => {
    const db = makeVersionsDb();
    (db.query.kbPageVersions as { findFirst: jest.Mock } & typeof db.query.kbPageVersions) as never;

    const versionsDb = {
      ...db,
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
    };
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = makeVersionsService(versionsDb as never, writer);

    await svc.listVersions(makeUser() as never, PAGE_ID);

    expect(spy).not.toHaveBeenCalled();
  });

  it("all public methods on KbPageVersionsService are classified so a new method cannot slip through untested", () => {
    const WRITER_DELEGATING = new Set(["restoreVersion"]);
    const NOT_DELEGATING = new Set(["listVersions", "getVersion"]);
    const all = protoMethods(KbPageVersionsService);
    const unclassified = [...all].filter(
      (m) => !WRITER_DELEGATING.has(m) && !NOT_DELEGATING.has(m),
    );
    expect(unclassified).toHaveLength(0);
  });
});

describe("KbPageTreeService — writer delegation for restore", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeRestoreDb() {
    let selectCallCount = 0;
    const tx = {
      execute: jest.fn().mockResolvedValue([{ id: PAGE_ID }]),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => {
            selectCallCount += 1;
            if (selectCallCount === 1) {
              return Promise.resolve([
                { id: PAGE_ID, contentRevision: 1, aclRevision: 1, contentText: "content" },
              ]);
            }
            return Promise.resolve([RETURNED_PAGE]);
          }),
        }),
      })),
    };
    return {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({
            id: PAGE_ID,
            parentPageId: null,
            deletedAt: new Date("2024-01-01"),
            title: "Test",
          }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
  }

  function makeRestoreService(
    db: ReturnType<typeof makeRestoreDb>,
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

  it("restore calls writer.commitManyPageChanges so a restored subtree is re-indexed atomically and does not disappear from search until backfill catches it", async () => {
    const db = makeRestoreDb();
    const writer = new KbPageWriterService({} as never);
    const spy = jest.spyOn(writer, "commitManyPageChanges").mockResolvedValue(undefined);
    const svc = makeRestoreService(db, writer);

    await svc.restore(makeUser() as never, PAGE_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });

  it("all public methods on KbPageTreeService are classified so a new method cannot slip through untested", () => {
    const WRITER_DELEGATING = new Set(["move", "restore"]);
    const NOT_DELEGATING = new Set([
      "getTreeLevel",
      "softDelete",
      "isDescendant",
    ]);
    const all = protoMethods(KbPageTreeService);
    const unclassified = [...all].filter(
      (m) => !WRITER_DELEGATING.has(m) && !NOT_DELEGATING.has(m),
    );
    expect(unclassified).toHaveLength(0);
  });
});
