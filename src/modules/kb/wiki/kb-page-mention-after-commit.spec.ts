import type { Db } from "../../../db/drizzle.module";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";

jest.mock("../../../common/tenant/tenant-context", () => ({
  ...jest.requireActual("../../../common/tenant/tenant-context"),
  registerAfterCommit: jest.fn(),
}));

jest.mock("./kb-page-edit.util", () => ({
  ...jest.requireActual("./kb-page-edit.util"),
  snapshotIfNeeded: jest.fn().mockResolvedValue(undefined),
  resyncPageLinks: jest.fn().mockResolvedValue(undefined),
}));

const ORG_ID = "org-mentions";
const PAGE_ID = 7;
const MENTIONED_USER_ID = "user-mentioned";

const registerAfterCommitMock = registerAfterCommit as jest.Mock;

const MENTION_CONTENT = {
  type: "doc",
  content: [
    { type: "mention", attrs: { id: MENTIONED_USER_ID } },
  ],
};

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-actor",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makeHarness(notifications: { create: jest.Mock }): {
  db: Db;
  createCallsWhenCallbackReturned: () => number;
} {
  let createCallsAtReturn = -1;

  const updated = {
    id: PAGE_ID,
    orgId: ORG_ID,
    title: "Handbook",
    visibility: "org",
    createdById: "user-actor",
    createdByMembershipId: 1,
    publicToken: null,
    contentRevision: 2,
    aclRevision: 1,
  };

  const tx = {
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([updated]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockResolvedValue(undefined),
    }),
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) } },
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest.fn().mockResolvedValue({
          id: PAGE_ID,
          isLocked: false,
          trustState: "unverified",
          content: null,
        }),
      },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb(tx);
      createCallsAtReturn = notifications.create.mock.calls.length;
      return result;
    }),
  } as unknown as Db;

  return { db, createCallsWhenCallbackReturned: () => createCallsAtReturn };
}

function makeService(db: Db, notifications: { create: jest.Mock }): KbPagesService {
  return new KbPagesService(
    db,
    {} as never,
    {
      assertPageAccess: jest.fn().mockResolvedValue({
        orgId: ORG_ID,
        pageId: PAGE_ID,
        action: "edit",
        via: "admin",
      }),
    } as never,
    {} as never,
    { log: jest.fn() } as never,
    new KbPageWriterService(notifications as never),
  );
}

describe("KbPagesService.update — mention notifications and the request transaction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers the mention notification for after commit instead of writing it inside the still open page transaction, where it either commits for an edit that rolls back or raises 42501 on a released handle", async () => {
    let hook: (() => Promise<void>) | null = null;
    registerAfterCommitMock.mockImplementation((candidate: () => Promise<void>) => {
      hook = candidate;
      return true;
    });
    const notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const harness = makeHarness(notifications);

    await makeService(harness.db, notifications).update(
      makeUser(),
      PAGE_ID,
      { content: MENTION_CONTENT },
      false,
    );

    expect(registerAfterCommitMock).toHaveBeenCalledTimes(1);
    expect(harness.createCallsWhenCallbackReturned()).toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();

    expect(hook).not.toBeNull();
    await (hook as unknown as () => Promise<void>)();

    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        userId: MENTIONED_USER_ID,
        sourceModule: "kb",
        link: `/knowledge/pages/${PAGE_ID}`,
      }),
    );
  });

  it("sends the mention inline when there is no commit hook to register against, because a caller outside a request transaction must not silently lose the notification", async () => {
    registerAfterCommitMock.mockReturnValue(false);
    const notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const harness = makeHarness(notifications);

    await makeService(harness.db, notifications).update(
      makeUser(),
      PAGE_ID,
      { content: MENTION_CONTENT },
      false,
    );

    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it("registers nothing when the edit adds no mention, so the deferral assertions above are not satisfied by an unconditional hook", async () => {
    registerAfterCommitMock.mockReturnValue(true);
    const notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const harness = makeHarness(notifications);

    await makeService(harness.db, notifications).update(
      makeUser(),
      PAGE_ID,
      { content: { type: "doc", content: [{ type: "paragraph" }] } },
      false,
    );

    expect(registerAfterCommitMock).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
