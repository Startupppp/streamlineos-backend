import "reflect-metadata";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import { extractMentionUserIds } from "./kb-page-content.util";

jest.mock("./kb-page-share-visibility", () => ({
  withoutUnsharedToken: (_user: unknown, page: unknown) => page,
}));

jest.mock("./kb-page-edit.util", () => ({
  snapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
  resyncPageLinks: jest.fn().mockResolvedValue(undefined),
  staleRevisionConflict: jest.fn().mockReturnValue(new Error("stale")),
  describeLatestPageEdit: jest.fn().mockResolvedValue({}),
  buildPageAncestors: jest.fn().mockResolvedValue([]),
}));

jest.mock("./kb-page-content.util", () => ({
  extractMentionUserIds: jest.fn().mockReturnValue([]),
  extractPageLinkIds: jest.fn().mockReturnValue([]),
}));

jest.mock("../../../common/tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn().mockReturnValue(true),
}));

const ORG_ID = "org-commit-atomicity";
const PAGE_ID = 44;

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

const CURRENT_PAGE = {
  id: PAGE_ID,
  isLocked: false,
  trustState: "unverified" as const,
  content: null,
};

const RETURNED_PAGE = {
  id: PAGE_ID,
  orgId: ORG_ID,
  title: "Test",
  slug: null,
  content: null,
  contentText: "text",
  contentRevision: 2,
  aclRevision: 2,
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
  ownerUserId: "new-owner",
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

function makeAuth() {
  return {
    assertPageAccess: jest.fn().mockResolvedValue(undefined),
    resolvePageAccess: jest.fn().mockResolvedValue({ outcome: "allowed" }),
    visiblePagePredicate: jest.fn(),
  };
}

function makeUpdateTx() {
  return {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([RETURNED_PAGE]),
        }),
      }),
    }),
  };
}

describe("claim (a): owner-change audit commits atomically with the page mutation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("owner-change audit is written with logCritical inside the transaction callback, not dispatched fire-and-forget after it commits", async () => {
    let auditCalledInsideTransaction = false;
    let transactionCallbackReturned = false;

    const tx = makeUpdateTx();
    const audit = {
      log: jest.fn(),
      logCritical: jest.fn().mockImplementation(async () => {
        auditCalledInsideTransaction = !transactionCallbackReturned;
      }),
    };

    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(tx);
        transactionCallbackReturned = true;
        return result;
      }),
    };

    const writer = new KbPageWriterService({} as never);
    jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    const svc = new KbPagesService(
      db as never,
      {} as never,
      makeAuth() as never,
      {} as never,
      audit as never,
      writer,
    );

    await svc.update(makeUser() as never, PAGE_ID, { ownerUserId: "new-owner" }, true);

    expect(auditCalledInsideTransaction).toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: page update with spaceId change succeeds and returns the updated row, proving the test infrastructure works independently of the audit assertion", async () => {
    const tx = makeUpdateTx();
    const audit = { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) };
    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
        kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
    const writer = new KbPageWriterService({} as never);
    jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    const svc = new KbPagesService(
      db as never,
      {} as never,
      makeAuth() as never,
      {} as never,
      audit as never,
      writer,
    );

    const result = await svc.update(makeUser() as never, PAGE_ID, { spaceId: 5 }, false);

    expect(result.id).toBe(PAGE_ID);
  });

  it("when the transaction throws, neither the updated row nor any audit record escapes the failed operation", async () => {
    const boom = new Error("db write failed");
    const failingTx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockRejectedValue(boom),
          }),
        }),
      }),
    };
    const audit = { log: jest.fn(), logCritical: jest.fn() };
    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(failingTx)),
    };
    const writer = new KbPageWriterService({} as never);
    jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);

    const svc = new KbPagesService(
      db as never,
      {} as never,
      makeAuth() as never,
      {} as never,
      audit as never,
      writer,
    );

    await expect(
      svc.update(makeUser() as never, PAGE_ID, { ownerUserId: "new-owner" }, true),
    ).rejects.toThrow("db write failed");

    expect(audit.logCritical).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("OutboxWriter.emit is called before the transaction callback returns, so the index event and the page mutation share the same transaction boundary", async () => {
    let emitCalledInsideTransaction = false;
    let transactionCallbackReturned = false;

    const tx = makeUpdateTx();
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockImplementation(async () => {
      emitCalledInsideTransaction = !transactionCallbackReturned;
    });
    const audit = { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) };

    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
        kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(tx);
        transactionCallbackReturned = true;
        return result;
      }),
    };

    const writer = new KbPageWriterService({} as never);
    const svc = new KbPagesService(
      db as never,
      {} as never,
      makeAuth() as never,
      {} as never,
      audit as never,
      writer,
    );

    await svc.update(makeUser() as never, PAGE_ID, { spaceId: 5 }, false);

    expect(emitCalledInsideTransaction).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "kb.content.index" }),
    );
  });
});

describe("claim (b): commitPageChange does not await any provider or embedding call inside the transaction", () => {
  beforeEach(() => jest.clearAllMocks());

  it("mention notifications are registered with registerAfterCommit so notifications.create is not called synchronously inside the transaction that carries the page mutation", async () => {
    const notifications = { create: jest.fn() };
    const writer = new KbPageWriterService(notifications as never);

    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    (extractMentionUserIds as jest.Mock)
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["user-added"]);

    await writer.commitPageChange({} as never, {
      orgId: ORG_ID,
      actor: { userId: "user-1", membershipId: null },
      page: {
        id: PAGE_ID,
        title: "T",
        contentRevision: 1,
        aclRevision: 1,
        contentText: null,
      },
      changed: {
        content: {
          newContent: { type: "doc" } as never,
          previousContent: null,
        },
      },
    });

    expect(notifications.create).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "kb.content.index" }),
    );
  });

  it("POSITIVE CONTROL: when registerAfterCommit returns false (no ambient context), fireKbMentionNotifications runs inline but OutboxWriter.emit is still called, confirming both paths execute the outbox write", async () => {
    const { registerAfterCommit } = jest.requireMock(
      "../../../common/tenant/tenant-context",
    ) as { registerAfterCommit: jest.Mock };
    registerAfterCommit.mockReturnValueOnce(false);

    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const writer = new KbPageWriterService(notifications as never);

    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    (extractMentionUserIds as jest.Mock)
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["user-added"]);

    await writer.commitPageChange({} as never, {
      orgId: ORG_ID,
      actor: { userId: "user-2", membershipId: null },
      page: {
        id: PAGE_ID,
        title: "T",
        contentRevision: 1,
        aclRevision: 1,
        contentText: null,
      },
      changed: {
        content: {
          newContent: { type: "doc" } as never,
          previousContent: null,
        },
      },
    });

    expect(notifications.create).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "kb.content.index" }),
    );
  });

  it("no embedding service method is invoked during commitPageChange: the service constructor accepts only NotificationsService, and no AI or object-store dependency appears in its injection signature", () => {
    const paramTypes = Reflect.getMetadata(
      "design:paramtypes",
      KbPageWriterService,
    ) as Function[] | undefined;

    expect(paramTypes).toBeDefined();
    const names = (paramTypes ?? []).map((t) => t.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("NotificationsService");
  });
});
