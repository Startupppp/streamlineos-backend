jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import { SOURCE_TIMEOUT_MS } from "./unified-inbox-sources";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { ApprovalInboxRow } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import {
  decodeInboxCursor,
  type UnifiedInboxResponse,
} from "./dto/unified-inbox.schemas";

const ORG = "org-1";
const UID = "user-1";
const LEAKED_MAILBOX = "victim@acme.test";
const LEAKED_SUBJECT = "Board pack Q3 — severance schedule";
const PROVIDER_MESSAGE = `gmail refused ${LEAKED_MAILBOX}: mailbox "${LEAKED_SUBJECT}" is locked`;

type ChainMethods = Record<string, jest.Mock>;

function makeChain(rows: unknown[]): ChainMethods {
  const chain: ChainMethods = {};
  for (const method of ["from", "leftJoin", "where", "orderBy", "limit", "offset"])
    chain[method] = jest.fn().mockImplementation(
      () => (method === "limit" ? Promise.resolve(rows) : chain),
    );
  return chain;
}

function makeDb(rows: unknown[] = []): Db {
  return { select: jest.fn().mockReturnValue(makeChain(rows)) } as unknown as Db;
}

function makeCursorDb(seeds: { id: number; createdAt: Date }[]) {
  const state: { cursor: number | null } = { cursor: null };
  const chain: ChainMethods = {};
  for (const method of ["from", "leftJoin", "where", "orderBy"])
    chain[method] = jest.fn().mockImplementation(() => chain);
  chain["limit"] = jest.fn().mockImplementation((take: number) =>
    Promise.resolve(
      [...seeds]
        .filter((s) => state.cursor === null || s.id < state.cursor)
        .sort((a, b) => b.id - a.id)
        .slice(0, take)
        .map(notifRow),
    ),
  );
  const db = { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
  return { db, state };
}

function notifRow(seed: { id: number; createdAt: Date }) {
  return {
    id: BigInt(seed.id),
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sourceModule: "system",
    eventKey: null,
    title: `Notif ${String(seed.id)}`,
    message: `Body ${String(seed.id)}`,
    link: null,
    isRead: false,
    pinned: false,
    createdAt: seed.createdAt,
    actorUserId: null,
    actorId: null,
    actorName: null,
    actorImage: null,
  };
}

function mailMessage(id: string, accountId: number, date: string) {
  return {
    id,
    threadId: `t-${id}`,
    accountId,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [],
    subject: `Mail ${id}`,
    snippet: "snippet",
    date,
    isRead: false,
    isStarred: false,
    hasAttachments: false,
  };
}

function approvalRow(id: number, createdAt: Date): ApprovalInboxRow {
  return {
    id,
    projectId: 10,
    title: `Approval ${String(id)}`,
    status: "pending",
    entityType: "task",
    entityId: 100 + id,
    dueAt: null,
    createdAt,
  };
}

function makeAccess(mail = true, approvals = true): AccessService {
  return {
    holds: jest.fn().mockImplementation((_user: unknown, key: string) => {
      if (key === "mail:inbox:view") return Promise.resolve(mail);
      if (key === "build:approvals:view") return Promise.resolve(approvals);
      return Promise.resolve(false);
    }),
  } as unknown as AccessService;
}

function makeBroadcasts(rows: unknown[] = []): BroadcastsService {
  return { listInboxPage: jest.fn().mockResolvedValue(rows) } as unknown as BroadcastsService;
}

function makeBuildApprovals(rows: ApprovalInboxRow[] = []): BuildApprovalsInboxService {
  return { getInboxPage: jest.fn().mockResolvedValue(rows) } as unknown as BuildApprovalsInboxService;
}

function makeRejectingBuildApprovals(): BuildApprovalsInboxService {
  return {
    getInboxPage: jest.fn().mockRejectedValue(new Error(PROVIDER_MESSAGE)),
  } as unknown as BuildApprovalsInboxService;
}

type MailMode = "ok" | "reject" | "hang";

function makeControllableMail(
  messages: unknown[] = [],
  accountErrors: { accountId: number; accountEmail: string; message: string }[] = [],
) {
  const state: { mode: MailMode } = { mode: "ok" };
  const listMessages = jest.fn().mockImplementation(() => {
    if (state.mode === "reject") return Promise.reject(new Error(PROVIDER_MESSAGE));
    if (state.mode === "hang") return new Promise(() => undefined);
    return Promise.resolve({ messages, nextCursor: null, accountErrors });
  });
  const service = {
    listMessages,
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
  } as unknown as MailService;
  return { service, listMessages, state };
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

async function listUnderFakeTimers(
  run: () => Promise<UnifiedInboxResponse>,
): Promise<UnifiedInboxResponse> {
  jest.useFakeTimers();
  try {
    const pending = run();
    await jest.advanceTimersByTimeAsync(SOURCE_TIMEOUT_MS + 1);
    return await pending;
  } finally {
    jest.useRealTimers();
  }
}

describe("unified inbox — one failed source does not lose the page", () => {
  const user = makeUser();
  const newest = new Date("2026-03-01T10:00:00.000Z");

  it("keeps the caller's own notifications when the mail read rejects", async () => {
    const mail = makeControllableMail();
    mail.state.mode = "reject";

    const svc = new UnifiedInboxService(
      makeDb([notifRow({ id: 7, createdAt: newest })]),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: undefined, unreadOnly: false },
      user,
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual(["notification:7"]);
    const mailSource = sourceOf(result, "mail");
    expect(mailSource.included).toBe(true);
    expect(mailSource.available).toBe(false);
    expect(mailSource.error).toBe("source unavailable");
    expect(result.degraded).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeInboxCursor(result.nextCursor).m).toBeNull();
  });

  it("does not re-read mail to advance its cursor when the mail read failed", async () => {
    const mail = makeControllableMail();
    mail.state.mode = "reject";

    const svc = new UnifiedInboxService(
      makeDb([notifRow({ id: 7, createdAt: newest })]),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

    expect(mail.listMessages).toHaveBeenCalledTimes(1);
  });

  it("classifies a mail read that never answers as a timeout", async () => {
    const mail = makeControllableMail();
    mail.state.mode = "hang";

    const svc = new UnifiedInboxService(
      makeDb([notifRow({ id: 7, createdAt: newest })]),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const result = await listUnderFakeTimers(() =>
      svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user),
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual(["notification:7"]);
    expect(sourceOf(result, "mail").error).toBe("timeout");
    expect(sourceOf(result, "mail").available).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(decodeInboxCursor(result.nextCursor).m).toBeNull();
  });

  it("keeps the other three sources when build approvals rejects", async () => {
    const mail = makeControllableMail([mailMessage("m1", 1, "2026-03-01T09:00:00.000Z")]);

    const svc = new UnifiedInboxService(
      makeDb([notifRow({ id: 7, createdAt: newest })]),
      makeAccess(),
      mail.service,
      makeBroadcasts([
        {
          id: 4,
          title: "Broadcast 4",
          message: "Broadcast body 4",
          type: "INFO",
          priority: "NORMAL",
          category: "SYSTEM",
          sentAt: new Date("2026-03-01T08:00:00.000Z"),
          createdAt: new Date("2026-03-01T08:00:00.000Z"),
        },
      ]),
      makeRejectingBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: undefined, unreadOnly: false },
      user,
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual([
      "notification:7",
      "mail:1:m1",
      "broadcast:4",
    ]);
    expect(sourceOf(result, "notification").available).toBe(true);
    expect(sourceOf(result, "broadcast").available).toBe(true);
    expect(sourceOf(result, "mail").available).toBe(true);
    expect(sourceOf(result, "build_approval").available).toBe(false);
    expect(sourceOf(result, "build_approval").error).toBe("source unavailable");
    expect(decodeInboxCursor(result.nextCursor).a).toBeNull();
  });

  it("reports how many mailboxes answered without naming any of them", async () => {
    const mail = makeControllableMail(
      [mailMessage("m1", 1, "2026-03-01T09:00:00.000Z")],
      [{ accountId: 2, accountEmail: LEAKED_MAILBOX, message: PROVIDER_MESSAGE }],
    );

    const svc = new UnifiedInboxService(
      makeDb([]),
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
    expect(mailSource.error).toBe("1 of 2 mail accounts unavailable");
    expect(mailSource.available).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.hasMore).toBe(true);
    expect(JSON.stringify(result)).not.toContain(LEAKED_MAILBOX);
  });

  it("marks mail unavailable when every mailbox errored and nothing came back", async () => {
    const mail = makeControllableMail(
      [],
      [
        { accountId: 2, accountEmail: LEAKED_MAILBOX, message: PROVIDER_MESSAGE },
        { accountId: 3, accountEmail: LEAKED_MAILBOX, message: PROVIDER_MESSAGE },
      ],
    );

    const svc = new UnifiedInboxService(
      makeDb([]),
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
    expect(mailSource.error).toBe("2 of 2 mail accounts unavailable");
    expect(mailSource.available).toBe(false);
    expect(result.degraded).toBe(true);
  });

  it("leaks nothing from a failed source — no message, no row, no mailbox", async () => {
    const mail = makeControllableMail();
    mail.state.mode = "reject";

    const svc = new UnifiedInboxService(
      makeDb([notifRow({ id: 7, createdAt: newest })]),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeRejectingBuildApprovals(),
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: undefined, unreadOnly: false },
      user,
    );

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(LEAKED_MAILBOX);
    expect(rendered).not.toContain(LEAKED_SUBJECT);
    expect(rendered).not.toContain("gmail refused");
    expect(result.items.some((i) => i.kind === "mail")).toBe(false);
    expect(result.items.some((i) => i.kind === "build_approval")).toBe(false);
    for (const source of result.sources) {
      if (source.error !== null)
        expect(["timeout", "source unavailable"]).toContain(source.error);
      if (source.reason !== null)
        expect(source.reason.startsWith("no permission: ")).toBe(true);
    }
  });

  it("withholds a cursor it cannot advance, so an identical cursor cannot loop", async () => {
    const mail = makeControllableMail();
    mail.state.mode = "reject";

    const svc = new UnifiedInboxService(
      makeDb([]),
      makeAccess(),
      mail.service,
      makeBroadcasts(),
      makeRejectingBuildApprovals(),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    for (let guard = 0; guard < 20; guard++) {
      const result = await svc.list(
        ORG,
        UID,
        { limit: 10, kinds: undefined, unreadOnly: false, cursor },
        user,
      );
      pages += 1;
      for (const item of result.items) seen.push(item.dedupKey);
      expect(result.degraded).toBe(true);
      if (!result.hasMore || result.nextCursor === null) break;
      expect(seen.length).toBeGreaterThan(0);
      cursor = result.nextCursor;
    }

    expect(pages).toBe(1);
    expect(seen).toEqual([]);
  });

  it("still advances the healthy sources while a failed source's cursor stands still", async () => {
    const notifications = makeCursorDb([
      { id: 2, createdAt: new Date("2026-03-01T12:00:00.000Z") },
      { id: 1, createdAt: new Date("2026-03-01T11:00:00.000Z") },
    ]);
    const mail = makeControllableMail();
    mail.state.mode = "reject";

    const svc = new UnifiedInboxService(
      notifications.db,
      makeAccess(true, false),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const first = await svc.list(
      ORG,
      UID,
      { limit: 1, kinds: ["notification", "mail"], unreadOnly: false },
      user,
    );

    expect(first.items.map((i) => i.dedupKey)).toEqual(["notification:2"]);
    expect(first.nextCursor).not.toBeNull();
    const state = decodeInboxCursor(first.nextCursor);
    expect(state.n).toBe(2);
    expect(state.m).toBeNull();

    notifications.state.cursor = state.n;
    const second = await svc.list(
      ORG,
      UID,
      { limit: 1, kinds: ["notification", "mail"], unreadOnly: false, cursor: first.nextCursor ?? undefined },
      user,
    );

    expect(second.items.map((i) => i.dedupKey)).toEqual(["notification:1"]);
    expect(decodeInboxCursor(second.nextCursor).m).toBeNull();
  });

  it("a source that timed out and then recovered skips nothing across the scroll", async () => {
    const notifications = makeCursorDb([
      { id: 2, createdAt: new Date("2026-03-01T12:00:00.000Z") },
      { id: 1, createdAt: new Date("2026-03-01T11:00:00.000Z") },
    ]);
    const mail = makeControllableMail([
      mailMessage("m1", 1, "2026-03-01T10:00:00.000Z"),
      mailMessage("m2", 1, "2026-03-01T09:00:00.000Z"),
    ]);
    mail.state.mode = "hang";

    const mailOnlyUser = makeUser();
    const svcWithMail = new UnifiedInboxService(
      notifications.db,
      makeAccess(true, false),
      mail.service,
      makeBroadcasts(),
      makeBuildApprovals(),
    );

    const delivered: string[] = [];
    let cursor: string | undefined;

    const first = await listUnderFakeTimers(() =>
      svcWithMail.list(
        ORG,
        UID,
        { limit: 2, kinds: ["notification", "mail"], unreadOnly: false, cursor },
        mailOnlyUser,
      ),
    );
    for (const item of first.items) delivered.push(item.dedupKey);
    expect(sourceOf(first, "mail").error).toBe("timeout");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    cursor = first.nextCursor ?? undefined;
    notifications.state.cursor = decodeInboxCursor(cursor).n;

    mail.state.mode = "ok";

    for (let page = 0; page < 2; page++) {
      const result = await svcWithMail.list(
        ORG,
        UID,
        { limit: 2, kinds: ["notification", "mail"], unreadOnly: false, cursor },
        mailOnlyUser,
      );
      for (const item of result.items) delivered.push(item.dedupKey);
      if (!result.hasMore || result.nextCursor === null) break;
      cursor = result.nextCursor;
      notifications.state.cursor = decodeInboxCursor(cursor).n;
    }

    expect(new Set(delivered).size).toBe(delivered.length);
    expect([...delivered].sort()).toEqual(
      ["notification:2", "notification:1", "mail:1:m1", "mail:1:m2"].sort(),
    );
  });
});
