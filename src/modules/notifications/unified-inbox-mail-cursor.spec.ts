jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";

/**
 * The unified inbox merges four sources into one page and throws away whatever
 * does not fit. Notifications, broadcasts and approvals resume from the id of
 * the last item that actually reached the page, so anything trimmed is fetched
 * again on the next request. Mail resumed from `nextMailCursor` — the END of the
 * batch it fetched — so every mail message trimmed by the merge was stepped over
 * and never delivered to anyone.
 *
 * It is silent: the reader sees a full page, scrolls, and the missing messages
 * simply are not there. Nothing errors, no count disagrees, and the gap widens
 * by up to a page on every scroll of a mixed inbox.
 */

type ChainMethods = Record<string, jest.Mock>;

function makeChain(rows: unknown[]): ChainMethods {
  const chain: ChainMethods = {};
  for (const method of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
    chain[method] = jest.fn().mockImplementation(
      () => (method === "limit" ? Promise.resolve(rows) : chain),
    );
  }
  return chain;
}

function makeDb(rows: unknown[]): Db {
  return { select: jest.fn().mockReturnValue(makeChain(rows)) } as unknown as Db;
}

function makeAccess(): AccessService {
  return {
    holds: jest.fn().mockImplementation((_u: unknown, key: string) =>
      Promise.resolve(key === "mail:inbox:view"),
    ),
  } as unknown as AccessService;
}

function makeUser(): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  } as CurrentUserContext;
}

function notifRow(id: number, createdAt: Date) {
  return {
    id: BigInt(id),
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sourceModule: "system",
    eventKey: null,
    title: `Notif ${String(id)}`,
    message: `Body ${String(id)}`,
    link: null,
    isRead: false,
    pinned: false,
    createdAt,
    actorUserId: null,
    actorId: null,
    actorName: null,
    actorImage: null,
  };
}

function mailMessage(index: number, date: string) {
  return {
    id: `m${String(index)}`,
    threadId: `t${String(index)}`,
    accountId: 1,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [],
    subject: `Mail ${String(index)}`,
    snippet: "snippet",
    date,
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  };
}

/**
 * A mailbox behind an OPAQUE cursor, the way a provider page token behaves: the
 * position addresses a batch boundary, never a message inside it.
 */
function makeMailbox(size: number) {
  const box = Array.from({ length: size }, (_, i) =>
    mailMessage(i, new Date(Date.UTC(2026, 0, 1, 0, 0, size - i)).toISOString()),
  );
  const listMessages = jest.fn().mockImplementation(
    (
      _orgId: string,
      _userId: string,
      _membershipId: number | null,
      _folder: string,
      _accountId: string,
      limit: number,
      cursor?: string,
    ) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const window = box.slice(start, start + limit);
      const next = start + window.length;
      return Promise.resolve({
        messages: window,
        nextCursor: next < box.length ? String(next) : null,
        accountErrors: [],
      });
    },
  );
  const service = { listMessages, countUnread: jest.fn() } as unknown as MailService;
  return { service, listMessages, size };
}

function makeBroadcasts(): BroadcastsService {
  return { listInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BroadcastsService;
}

function makeBuildApprovals(): BuildApprovalsInboxService {
  return { getInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BuildApprovalsInboxService;
}

const ORG = "org-1";
const UID = "user-1";
const LIMIT = 5;

/**
 * Three notifications newer than every message, so the merge always fills the
 * first three slots with notifications and hands mail the remaining two. Six
 * messages are fetched (`limit + 1`) and four of them are trimmed.
 */
function buildService(mailboxSize: number) {
  const notifications = [
    notifRow(103, new Date(Date.UTC(2026, 0, 2, 0, 0, 3))),
    notifRow(102, new Date(Date.UTC(2026, 0, 2, 0, 0, 2))),
    notifRow(101, new Date(Date.UTC(2026, 0, 2, 0, 0, 1))),
  ];
  const mailbox = makeMailbox(mailboxSize);
  const svc = new UnifiedInboxService(
    makeDb(notifications),
    makeAccess(),
    mailbox.service,
    makeBroadcasts(),
    makeBuildApprovals(),
  );
  return { svc, mailbox };
}

async function scroll(pages: number, mailboxSize: number) {
  const { svc, mailbox } = buildService(mailboxSize);
  const user = makeUser();
  const delivered: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await svc.list(
      ORG,
      UID,
      { limit: LIMIT, kinds: undefined, unreadOnly: false, cursor },
      user,
    );
    for (const item of page.items) if (item.kind === "mail") delivered.push(item.id);
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { delivered, mailbox };
}

describe("unified inbox — mail trimmed by the merge is not lost", () => {
  it("BITE: delivers every message in the mailbox across the scroll", async () => {
    const { delivered } = await scroll(12, 8);
    expect([...delivered].sort()).toEqual(
      ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"].sort(),
    );
  });

  it("BITE: delivers the message immediately after the page boundary on the next page", async () => {
    const { svc } = buildService(8);
    const user = makeUser();

    const first = await svc.list(
      ORG, UID, { limit: LIMIT, kinds: undefined, unreadOnly: false }, user,
    );
    const firstMail = first.items.filter((i) => i.kind === "mail").map((i) => i.id);
    expect(firstMail).toEqual(["m0", "m1"]);

    const second = await svc.list(
      ORG,
      UID,
      { limit: LIMIT, kinds: undefined, unreadOnly: false, cursor: first.nextCursor ?? undefined },
      user,
    );
    const secondMail = second.items.filter((i) => i.kind === "mail").map((i) => i.id);
    expect(secondMail[0]).toBe("m2");
  });

  it("delivers no message twice", async () => {
    const { delivered } = await scroll(12, 8);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("still advances the mailbox position once a batch has been fully delivered", async () => {
    const { svc, mailbox } = buildService(30);
    const user = makeUser();

    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await svc.list(
        ORG, UID, { limit: LIMIT, kinds: undefined, unreadOnly: false, cursor }, user,
      );
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    const starts = mailbox.listMessages.mock.calls.map((c) => c[6] as string | undefined);
    expect(starts.some((s) => s !== undefined && Number(s) > 0)).toBe(true);
  });
});
