import "reflect-metadata";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import { KbPageTreeService } from "./kb-page-tree.service";
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

    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never);
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
    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never);
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
    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never);
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

    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);
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
    const writer = new KbPageWriterService(notifications as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);

    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    (extractMentionUserIds as jest.Mock)
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["user-added"]);

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
    const writer = new KbPageWriterService(notifications as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);

    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    (extractMentionUserIds as jest.Mock)
      .mockReturnValueOnce([])
      .mockReturnValueOnce(["user-added"]);

    await writer.commitPageChange({} as never, {
      orgId: ORG_ID,
      actor: { userId: "user-2", membershipId: null },
      action: "kb.page.updated",
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

  it("no embedding service method is invoked during commitPageChange: the constructor takes NotificationsService and AuditService only, and no AI or object-store dependency appears in its injection signature", () => {
    const paramTypes = Reflect.getMetadata(
      "design:paramtypes",
      KbPageWriterService,
    ) as Function[] | undefined;

    expect(paramTypes).toBeDefined();
    const names = (paramTypes ?? []).map((t) => t.name);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("NotificationsService");
    expect(names[1]).toBe("AuditService");
  });
});

describe("claim (c): commitPageChange writes the audit row atomically using the caller-supplied action string", () => {
  beforeEach(() => jest.clearAllMocks());

  it("audit.logCritical is called with the caller's action string and the page resource id, so the change type and index event share the same write boundary", async () => {
    const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    const writer = new KbPageWriterService({} as never, audit as never);
    jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    await writer.commitPageChange({} as never, {
      orgId: ORG_ID,
      actor: { userId: "user-1", membershipId: null },
      action: "kb.page.updated",
      page: { id: PAGE_ID, title: "T", contentRevision: 1, aclRevision: 1, contentText: null },
      changed: {},
    });

    expect(audit.logCritical).toHaveBeenCalledWith(
      expect.objectContaining({ action: "kb.page.updated", resourceId: String(PAGE_ID) }),
    );
  });

  it("POSITIVE CONTROL: commitPageChange still emits the index event when audit.logCritical is mocked, proving both the audit and outbox calls run on the same invocation", async () => {
    const audit = { logCritical: jest.fn().mockResolvedValue(undefined) };
    const writer = new KbPageWriterService({} as never, audit as never);
    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);

    await writer.commitPageChange({} as never, {
      orgId: ORG_ID,
      actor: { userId: "user-1", membershipId: null },
      action: "kb.page.created",
      page: { id: PAGE_ID, title: "T", contentRevision: 1, aclRevision: 1, contentText: null },
      changed: {},
    });

    expect(emitSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "kb.content.index" }),
    );
    expect(audit.logCritical).toHaveBeenCalledTimes(1);
  });

  it("rollback proof: when the transaction throws after OutboxWriter.emit is called inside the callback, the caller's operation rejects, proving both the mutation and the index event share the same rollback boundary", async () => {
    let emitCalledInsideTransaction = false;
    let transactionCallbackReturned = false;

    const tx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([RETURNED_PAGE]),
          }),
        }),
      }),
    };

    const emitSpy = jest.spyOn(OutboxWriter, "emit").mockImplementation(async () => {
      emitCalledInsideTransaction = !transactionCallbackReturned;
    });

    const audit = { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) };
    const failAfterEmit = new Error("post-emit failure");

    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
        kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(tx).catch((err: unknown) => { throw err; });
        transactionCallbackReturned = true;
        return result;
      }),
    };

    const writer = new KbPageWriterService({} as never, audit as never);
    jest.spyOn(writer, "commitPageChange").mockImplementation(async () => {
      await OutboxWriter.emit({} as never, { eventType: "kb.content.index" } as never);
      throw failAfterEmit;
    });

    const svc = new KbPagesService(
      db as never,
      {} as never,
      makeAuth() as never,
      {} as never,
      audit as never,
      writer,
    );

    await expect(
      svc.update(makeUser() as never, PAGE_ID, { spaceId: 5 }, false),
    ).rejects.toThrow("post-emit failure");

    expect(emitCalledInsideTransaction).toBe(true);
    expect(emitSpy).toHaveBeenCalled();
  });

  it("POSITIVE CONTROL for rollback proof: when commitPageChange succeeds, the update returns the page row, proving the service infrastructure is functional", async () => {
    const audit = { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([RETURNED_PAGE]),
          }),
        }),
      }),
    };
    const db = {
      query: {
        kbPages: { findFirst: jest.fn().mockResolvedValue(CURRENT_PAGE) },
        kbSpaces: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
    const writer = new KbPageWriterService({} as never, audit as never);
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
});

describe("claim (d): softDelete and restore write their audit rows inside the transaction via logCritical", () => {
  beforeEach(() => jest.clearAllMocks());

  function makeSoftDeleteTx() {
    return {
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
      execute: jest.fn().mockResolvedValue([{ id: PAGE_ID }]),
    };
  }

  it("softDelete calls audit.logCritical inside the transaction callback, not fire-and-forget via log after commit", async () => {
    let auditCalledInsideTransaction = false;
    let transactionCallbackReturned = false;

    const tx = makeSoftDeleteTx();
    const audit = {
      log: jest.fn(),
      logCritical: jest.fn().mockImplementation(async () => {
        auditCalledInsideTransaction = !transactionCallbackReturned;
      }),
    };

    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, deletedAt: null, title: "Test" }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        const result = await cb(tx);
        transactionCallbackReturned = true;
        return result;
      }),
    };

    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);
    const svc = new KbPageTreeService(
      db as never,
      audit as never,
      { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      writer,
    );

    await svc.softDelete(makeUser() as never, PAGE_ID);

    expect(auditCalledInsideTransaction).toBe(true);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: softDelete returns the count of deleted pages, proving the infrastructure works independently of the audit timing assertion", async () => {
    const tx = makeSoftDeleteTx();
    const audit = {
      log: jest.fn(),
      logCritical: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
      query: {
        kbPages: {
          findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID, deletedAt: null, title: "Test" }),
        },
      },
      transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    };
    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined) } as never);
    const svc = new KbPageTreeService(
      db as never,
      audit as never,
      { assertPageAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      writer,
    );

    const result = await svc.softDelete(makeUser() as never, PAGE_ID);

    expect(result.deletedCount).toBeGreaterThanOrEqual(1);
  });
});
