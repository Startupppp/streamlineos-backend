jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import type { UnifiedInboxResponse } from "./dto/unified-inbox.schemas";

const ORG = "org-1";
const UID = "user-1";

function makeDb(): Db {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
    chain[method] = jest.fn().mockImplementation(
      () => (method === "limit" ? Promise.resolve([]) : chain),
    );
  }
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

function makeAccess(mailPerm = true): AccessService {
  return {
    holds: jest.fn().mockImplementation((_user: unknown, key: string) => {
      if (key === "mail:inbox:view") return Promise.resolve(mailPerm);
      return Promise.resolve(false);
    }),
  } as unknown as AccessService;
}

function makeBroadcasts(): BroadcastsService {
  return { listInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BroadcastsService;
}

function makeBuildApprovals(): BuildApprovalsInboxService {
  return { getInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BuildApprovalsInboxService;
}

type MailMock = {
  service: MailService;
  areAllAccountsFresh: jest.Mock;
  listMessages: jest.Mock;
};

function makeMail(fresh: boolean): MailMock {
  const areAllAccountsFresh = jest.fn().mockResolvedValue(fresh);
  const listMessages = jest
    .fn()
    .mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] });
  const service = {
    areAllAccountsFresh,
    listMessages,
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
  } as unknown as MailService;
  return { service, areAllAccountsFresh, listMessages };
}

function makeUser(): CurrentUserContext {
  return {
    userId: UID,
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  } as CurrentUserContext;
}

function sourceOf(result: UnifiedInboxResponse, kind: string) {
  const found = result.sources.find((s) => s.kind === kind);
  if (!found) throw new Error(`no source status for ${kind}`);
  return found;
}

describe("unified inbox — unreadOnly mail freshness gate", () => {
  const user = makeUser();

  it("BITE: includes mail when unreadOnly is false and mailbox is stale", async () => {
    const mail = makeMail(false);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["mail"], unreadOnly: false },
      user,
    );

    const mailSource = sourceOf(result, "mail");
    expect(mailSource.included).toBe(true);
    expect(mailSource.reason).toBeNull();
  });

  it("BITE: includes mail when unreadOnly is true and all accounts are fresh", async () => {
    const mail = makeMail(true);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["mail"], unreadOnly: true },
      user,
    );

    const mailSource = sourceOf(result, "mail");
    expect(mailSource.included).toBe(true);
    expect(mailSource.reason).toBeNull();
  });

  it("BITE: excludes mail with unsupported reason when unreadOnly is true and mailbox is stale", async () => {
    const mail = makeMail(false);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["mail"], unreadOnly: true },
      user,
    );

    const mailSource = sourceOf(result, "mail");
    expect(mailSource.included).toBe(false);
    expect(mailSource.reason).toBe("unsupported: unreadOnly (mailbox not synced)");
  });

  it("does not call areAllAccountsFresh when unreadOnly is false", async () => {
    const mail = makeMail(false);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    await svc.list(ORG, UID, { limit: 10, kinds: ["mail"], unreadOnly: false }, user);

    expect(mail.areAllAccountsFresh).not.toHaveBeenCalled();
  });

  it("does not call areAllAccountsFresh when the caller has no mail:inbox:view permission", async () => {
    const mail = makeMail(false);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(false),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["mail"], unreadOnly: true },
      user,
    );

    expect(mail.areAllAccountsFresh).not.toHaveBeenCalled();
    expect(sourceOf(result, "mail").included).toBe(false);
  });

  it("does not call listMessages when unreadOnly is true and mailbox is stale", async () => {
    const mail = makeMail(false);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    await svc.list(ORG, UID, { limit: 10, kinds: ["mail"], unreadOnly: true }, user);

    expect(mail.listMessages).not.toHaveBeenCalled();
  });

  it("calls listMessages with unreadOnly=true when the mailbox is fresh", async () => {
    const mail = makeMail(true);
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    await svc.list(ORG, UID, { limit: 10, kinds: ["mail"], unreadOnly: true }, user);

    expect(mail.listMessages).toHaveBeenCalled();
    const callArgs: unknown[] = mail.listMessages.mock.calls[0] as unknown[];
    expect(callArgs[8]).toBe(true);
  });
});
