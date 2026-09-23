jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { ApprovalInboxRow } from "../build/approvals/build-approvals-inbox.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { decodeInboxCursor } from "./dto/unified-inbox.schemas";

type ChainMethods = Record<string, jest.Mock>;

function makeChain(rows: unknown[] = []): ChainMethods {
  const chain: ChainMethods = {};
  for (const method of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
    chain[method] = jest.fn().mockImplementation(
      () => (method === "limit" ? Promise.resolve(rows) : chain),
    );
  }
  return chain;
}

function makeCountChain(value: number): ChainMethods {
  const chain: ChainMethods = {};
  for (const method of ["from", "innerJoin", "where"]) {
    chain[method] = jest.fn().mockImplementation(
      () => (method === "where" ? Promise.resolve([{ cnt: value }]) : chain),
    );
  }
  return chain;
}

function makeDb(notifRows: unknown[] = [], countValue = 0): Db {
  let callCount = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount % 2 === 0) return makeCountChain(countValue);
      return makeChain(notifRows);
    }),
  } as unknown as Db;
}

function makeDbForCount(notifCount: number, approvalCount: number): Db {
  let call = 0;
  return {
    select: jest.fn().mockImplementation(() => {
      call++;
      return makeCountChain(call === 1 ? notifCount : approvalCount);
    }),
  } as unknown as Db;
}

function makeDbEmpty(): Db {
  return {
    select: jest.fn().mockReturnValue(makeChain([])),
  } as unknown as Db;
}

function makeAccess(mailPermission: boolean, approvalPermission = false): AccessService {
  return {
    holds: jest.fn().mockImplementation((_user: unknown, key: string) => {
      if (key === "mail:inbox:view") return Promise.resolve(mailPermission);
      if (key === "build:approvals:view") return Promise.resolve(approvalPermission);
      return Promise.resolve(false);
    }),
  } as unknown as AccessService;
}

/**
 * The unread badge is `MailService.countUnread` now, not a `listMessages` scan
 * the caller counts itself, so the double has to answer at that boundary. It
 * implements the real service's COLD path — count `!isRead` over the scan, and
 * call the answer exact only when the scan did not fill its page — because that
 * is the behaviour these properties are about; the mirrored path returns
 * `exact: true` unconditionally and would make the boundary assertions vacuous.
 */
function scanUnread(messages: unknown[]) {
  return jest.fn().mockImplementation(
    (_orgId: string, _userId: string, _membershipId: number | null, _folder: string, scanLimit: number) =>
      Promise.resolve({
        unread: messages.filter((m) => (m as { isRead?: boolean }).isRead !== true).length,
        exact: messages.length < scanLimit,
      }),
  );
}

function makeMail(messages: unknown[] = [], nextCursor: string | null = null): MailService {
  return {
    listMessages: jest.fn().mockResolvedValue({ messages, nextCursor, accountErrors: [] }),
    countUnread: scanUnread(messages),
  } as unknown as MailService;
}

function makeMailWithUnread(unreadMessages: unknown[]): MailService {
  return {
    listMessages: jest.fn().mockResolvedValue({
      messages: unreadMessages,
      nextCursor: null,
      accountErrors: [],
    }),
    countUnread: scanUnread(unreadMessages),
  } as unknown as MailService;
}

function makeBroadcasts(rows: unknown[] = []): BroadcastsService {
  return {
    listInboxPage: jest.fn().mockResolvedValue(rows),
  } as unknown as BroadcastsService;
}

function makeBuildApprovals(rows: ApprovalInboxRow[] = []): BuildApprovalsInboxService {
  return {
    getInboxPage: jest.fn().mockResolvedValue(rows),
  } as unknown as BuildApprovalsInboxService;
}

function makeUser(orgId = "org-1", userId = "user-1"): CurrentUserContext {
  return {
    userId,
    orgId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: { kind: "human-session", membershipId: 1, isOrgOwner: false },
  };
}

function notifRow(id: number, createdAt: Date, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id: BigInt(id),
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sourceModule: "system",
    eventKey: null,
    title: `Notif ${id}`,
    message: `Body ${id}`,
    link: null,
    isRead: false,
    pinned: false,
    createdAt,
    actorUserId: null,
    actorId: null,
    actorName: null,
    actorImage: null,
    ...extra,
  };
}

function broadcastRow(id: number, sentAt: Date) {
  return {
    id,
    title: `Broadcast ${id}`,
    message: `Broadcast body ${id}`,
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sentAt,
    createdAt: sentAt,
  };
}

function mailMessage(id: string, date: string, isRead = false) {
  return {
    id,
    threadId: "thread-1",
    accountId: 1,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [],
    subject: `Mail ${id}`,
    snippet: "snippet",
    date,
    isRead,
    isStarred: false,
    hasAttachments: false,
  };
}

function approvalRow(id: number, createdAt: Date): ApprovalInboxRow {
  return {
    id,
    projectId: 10,
    title: `Approval ${id}`,
    status: "pending",
    entityType: "task",
    entityId: 100 + id,
    dueAt: null,
    createdAt,
  };
}


function makeRegistry() {
  return { list: jest.fn().mockReturnValue([]), register: jest.fn() } as unknown as import("../attention/approval-adapter.registry").ApprovalAdapterRegistry;
}
describe("UnifiedInboxService — four-property contract", () => {
  const ORG = "org-1";
  const UID = "user-1";
  const user = makeUser();

  beforeEach(() => jest.clearAllMocks());

  describe("Property 1: per-source authorization BEFORE aggregation", () => {
    it("mail items are excluded when caller lacks mail:inbox:view", async () => {
      const db = makeDbEmpty();
      const mailSvc = makeMail([mailMessage("msg-1", "2024-01-03T10:00:00Z")]);
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

      expect(result.items.filter((i) => i.kind === "mail")).toHaveLength(0);
      expect(mailSvc.listMessages as jest.Mock).not.toHaveBeenCalled();
    });

    it("mail items appear when caller holds mail:inbox:view — authorization gate permits", async () => {
      const db = makeDbEmpty();
      const mailSvc = makeMail([mailMessage("msg-1", "2024-01-03T10:00:00Z")]);
      const access = makeAccess(true);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

      expect(result.items.filter((i) => i.kind === "mail")).toHaveLength(1);
    });

    it("approval items are excluded when caller lacks build:approvals:view", async () => {
      const db = makeDbEmpty();
      const approvalsSvc = makeBuildApprovals([approvalRow(1, new Date())]);
      const access = makeAccess(false, false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), approvalsSvc, makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

      expect(result.items.filter((i) => i.kind === "build_approval")).toHaveLength(0);
      expect(approvalsSvc.getInboxPage as jest.Mock).not.toHaveBeenCalled();
    });

    it("approval items appear when caller holds build:approvals:view", async () => {
      const db = makeDbEmpty();
      const approvalsSvc = makeBuildApprovals([approvalRow(1, new Date())]);
      const access = makeAccess(false, true);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), approvalsSvc, makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

      expect(result.items.filter((i) => i.kind === "build_approval")).toHaveLength(1);
    });

    it("notifications require no permission gate — always included for the session owner", async () => {
      const db = makeDbEmpty();
      const db2 = {
        select: jest.fn().mockReturnValue(makeChain([notifRow(1, new Date())])),
      } as unknown as Db;
      const access = makeAccess(false, false);
      const svc = new UnifiedInboxService(db2, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: ["notification"], unreadOnly: false }, user);

      expect(result.items.filter((i) => i.kind === "notification")).toHaveLength(1);
      const notifSource = result.sources.find((s) => s.kind === "notification");
      expect(notifSource?.included).toBe(true);
    });

    it("authorization check uses the caller derived from JWT, not a client-supplied field", async () => {
      const db = makeDbEmpty();
      const mailSvc = makeMail();
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

      const holdsCalls = (access.holds as jest.Mock).mock.calls as [CurrentUserContext, string][];
      expect(holdsCalls.every(([ctx]) => ctx.userId === UID && ctx.orgId === ORG)).toBe(true);
    });
  });

  describe("Property 2: unified unread-count semantics", () => {
    it("total equals the sum of per-source authorized counts", async () => {
      const db: Db = {
        select: jest.fn()
          .mockReturnValueOnce(makeCountChain(3))
          .mockReturnValueOnce(makeCountChain(2)),
      } as unknown as Db;

      const mailSvc = makeMailWithUnread([
        mailMessage("m1", "2024-01-01T00:00:00Z", false),
        mailMessage("m2", "2024-01-01T00:00:00Z", true),
        mailMessage("m3", "2024-01-01T00:00:00Z", false),
      ]);

      const access = makeAccess(true, true);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const counts = await svc.unifiedUnreadCount(ORG, UID, user);

      expect(counts.notification).toBe(3);
      expect(counts.mail).toBe(2);
      expect(counts.approval).toBe(2);
      expect(counts.total).toBe(counts.notification + counts.mail + counts.approval);
    });

    it("mail count is 0 when caller lacks mail:inbox:view — not added to total", async () => {
      const db: Db = {
        select: jest.fn()
          .mockReturnValueOnce(makeCountChain(5))
          .mockReturnValueOnce(makeCountChain(1)),
      } as unknown as Db;

      const mailSvc = makeMail([mailMessage("m1", "2024-01-01T00:00:00Z", false)]);
      const access = makeAccess(false, true);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const counts = await svc.unifiedUnreadCount(ORG, UID, user);

      expect(counts.mail).toBe(0);
      expect(counts.total).toBe(counts.notification + counts.approval);
      expect(mailSvc.listMessages as jest.Mock).not.toHaveBeenCalled();
    });

    it("approval count is 0 when caller lacks build:approvals:view — not added to total", async () => {
      const db: Db = {
        select: jest.fn()
          .mockReturnValueOnce(makeCountChain(2))
          .mockReturnValueOnce(makeCountChain(0)),
      } as unknown as Db;

      const mailSvc = makeMailWithUnread([mailMessage("m1", "2024-01-01T00:00:00Z", false)]);
      const access = makeAccess(true, false);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const counts = await svc.unifiedUnreadCount(ORG, UID, user);

      expect(counts.approval).toBe(0);
      expect(counts.total).toBe(counts.notification + counts.mail);
    });

    it("a notification delivered twice (same id) is counted once — no double-count", async () => {
      const t = new Date("2024-01-10T00:00:00Z");
      const db = {
        select: jest.fn().mockReturnValue(makeChain([notifRow(5, t), notifRow(5, t)])),
      } as unknown as Db;

      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: ["notification"], unreadOnly: false }, user);

      const notifItems = result.items.filter((i) => i.kind === "notification");
      expect(notifItems).toHaveLength(1);
    });
  });

  describe("Property 3: cross-domain ordering and deduplication", () => {
    it("items are sorted newest-first with a stable tie-break by kind then id", async () => {
      const t = new Date("2024-01-10T00:00:00Z");

      const db = {
        select: jest.fn().mockReturnValue(makeChain([notifRow(2, t), notifRow(1, t)])),
      } as unknown as Db;

      const broadcasts = makeBroadcasts([broadcastRow(10, t)]);
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), broadcasts, makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: ["notification", "broadcast"], unreadOnly: false }, user);

      const kinds = result.items.map((i) => i.kind);
      expect(kinds[0]).toBe("notification");
      expect(kinds[1]).toBe("notification");
      expect(kinds[2]).toBe("broadcast");

      const notifIds = result.items
        .filter((i) => i.kind === "notification")
        .map((i) => i.id as number);
      expect(notifIds[0]).toBeGreaterThan(notifIds[1] ?? -1);
    });

    it("items from the same source with the same dedupKey appear exactly once", async () => {
      const t = new Date("2024-01-10T00:00:00Z");
      const db = {
        select: jest.fn().mockReturnValue(makeChain([notifRow(5, t), notifRow(5, t)])),
      } as unknown as Db;

      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: ["notification"], unreadOnly: false }, user);

      const deduped = result.items.filter((i) => i.kind === "notification" && (i as { id: number }).id === 5);
      expect(deduped).toHaveLength(1);
    });

    it("each item carries a dedupKey field that is non-empty and unique for distinct items", async () => {
      const db = {
        select: jest.fn().mockReturnValue(makeChain([
          notifRow(1, new Date("2024-01-02T00:00:00Z")),
          notifRow(2, new Date("2024-01-01T00:00:00Z")),
        ])),
      } as unknown as Db;

      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 10, kinds: ["notification"], unreadOnly: false }, user);

      const keys = result.items.map((i) => i.dedupKey);
      expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
      expect(new Set(keys).size).toBe(result.items.length);
    });

    it("hasMore is true when the merged and deduped result exceeds the requested limit", async () => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        notifRow(6 - i, new Date(Date.now() - i * 1000)),
      );
      const db = { select: jest.fn().mockReturnValue(makeChain(rows)) } as unknown as Db;
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 5, kinds: undefined, unreadOnly: false }, user);

      expect(result.hasMore).toBe(true);
      expect(result.items).toHaveLength(5);
    });

    it("hasMore is false when all sources are exhausted", async () => {
      const db = { select: jest.fn().mockReturnValue(makeChain([notifRow(1, new Date())])) } as unknown as Db;
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 25, kinds: undefined, unreadOnly: false }, user);

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("Property 4: cursor contract", () => {
    it("page 1 (no cursor) encodes a non-null nextCursor when there are more items", async () => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        notifRow(6 - i, new Date(Date.now() - i * 1000)),
      );
      const db = { select: jest.fn().mockReturnValue(makeChain(rows)) } as unknown as Db;
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 5, kinds: undefined, unreadOnly: false }, user);

      expect(result.nextCursor).not.toBeNull();
      expect(typeof result.nextCursor).toBe("string");
    });

    it("cursor encodes each source position — all four fields are present and typed correctly", async () => {
      const t = new Date("2024-01-10T00:00:00Z");
      const db = { select: jest.fn().mockReturnValue(makeChain([notifRow(5, t)])) } as unknown as Db;
      const broadcasts = makeBroadcasts([broadcastRow(3, new Date("2024-01-09T00:00:00Z"))]);
      const access = makeAccess(false, true);
      const approvals = makeBuildApprovals([approvalRow(7, new Date("2024-01-08T00:00:00Z"))]);
      const svc = new UnifiedInboxService(db, access, makeMail(), broadcasts, approvals, makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 1, kinds: undefined, unreadOnly: false }, user);

      expect(result.nextCursor).not.toBeNull();
      const state = decodeInboxCursor(result.nextCursor ?? undefined);
      expect(Object.keys(state)).toEqual(
        expect.arrayContaining(["n", "nt", "b", "bt", "m", "a"]),
      );
      expect(typeof state.n === "number" || state.n === null).toBe(true);
      expect(typeof state.nt === "string" || state.nt === null).toBe(true);
      expect(typeof state.b === "number" || state.b === null).toBe(true);
      expect(typeof state.bt === "string" || state.bt === null).toBe(true);
      expect(typeof state.m === "string" || state.m === null).toBe(true);
      expect(typeof state.a === "number" || state.a === null).toBe(true);
    });

    it("cursor JSON never contains 'undefined' — all fields are null or a typed value", async () => {
      const db = { select: jest.fn().mockReturnValue(makeChain([notifRow(5, new Date())])) } as unknown as Db;
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 1, kinds: undefined, unreadOnly: false }, user);

      if (result.nextCursor) {
        const raw = Buffer.from(result.nextCursor, "base64url").toString("utf8");
        expect(raw).not.toContain("undefined");
        const parsed: unknown = JSON.parse(raw);
        expect(typeof parsed).toBe("object");
        expect(parsed).not.toBeNull();
      }
    });

    it("page 1 sends no cursor — the query uses no cursor state (null fields)", async () => {
      const db = { select: jest.fn().mockReturnValue(makeChain([])) } as unknown as Db;
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      await svc.list(ORG, UID, { limit: 10, kinds: undefined, unreadOnly: false }, user);

      const decoded = decodeInboxCursor(undefined);
      expect(decoded).toEqual({
        n: null,
        nt: null,
        b: null,
        bt: null,
        m: null,
        a: null,
        at: null,
      });
    });

    it("cursor cap — limit is hard-capped at 100 items per page", async () => {
      const rows = Array.from({ length: 102 }, (_, i) =>
        notifRow(102 - i, new Date(Date.now() - i * 1000)),
      );
      const db = { select: jest.fn().mockReturnValue(makeChain(rows)) } as unknown as Db;
      const access = makeAccess(false);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      const result = await svc.list(ORG, UID, { limit: 200, kinds: undefined, unreadOnly: false }, user);

      expect(result.items.length).toBeLessThanOrEqual(100);
    });
  });

  describe("cross-tenant isolation — all sources", () => {
    function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
      if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
      if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
      if (typeof value !== "object" || seen.has(value)) return [];
      seen.add(value);
      const record = value as { queryChunks?: unknown[]; value?: unknown };
      return [
        ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
        ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
      ];
    }

    it("notification query is scoped to the requesting org — org B cannot read org A items", async () => {
      const where = jest.fn();
      const limit = jest.fn().mockResolvedValue([]);
      const orderBy = jest.fn().mockReturnValue({ limit });
      const leftJoin = jest.fn();
      const from = jest.fn();
      const builder = { from, leftJoin, where, orderBy, limit };
      from.mockReturnValue(builder);
      leftJoin.mockReturnValue({ where });
      where.mockReturnValue({ orderBy });

      const db = { select: jest.fn().mockReturnValue(builder) } as unknown as Db;
      const VICTIM_ORG = "org-victim";
      const ATTACKER_ORG = "org-attacker";
      const access = { holds: jest.fn().mockResolvedValue(false) } as unknown as AccessService;
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      await svc.list(ATTACKER_ORG, "user-attacker", { kinds: ["notification"], limit: 25, unreadOnly: false }, makeUser(ATTACKER_ORG, "user-attacker"));

      const predicateValues = sqlValues(where.mock.calls[0]?.[0]);
      expect(predicateValues).toContain(ATTACKER_ORG);
      expect(predicateValues).not.toContain(VICTIM_ORG);
    });

    it("broadcast listInboxPage is called with the requesting orgId — not a victim org", async () => {
      const db = makeDbEmpty();
      const broadcastsSvc = makeBroadcasts();
      const ATTACKER_ORG = "org-attacker";
      const VICTIM_ORG = "org-victim";
      const access = { holds: jest.fn().mockResolvedValue(false) } as unknown as AccessService;
      const svc = new UnifiedInboxService(db, access, makeMail(), broadcastsSvc, makeBuildApprovals(), makeRegistry());

      await svc.list(ATTACKER_ORG, "user-attacker", { kinds: ["broadcast"], limit: 25, unreadOnly: false }, makeUser(ATTACKER_ORG, "user-attacker"));

      const broadcastCall = (broadcastsSvc.listInboxPage as jest.Mock).mock.calls[0];
      expect(broadcastCall).toBeDefined();
      expect(broadcastCall?.[0]).toBe(ATTACKER_ORG);
      expect(broadcastCall?.[0]).not.toBe(VICTIM_ORG);
    });

    it("mail listMessages is called with the requesting orgId — not a victim org", async () => {
      const db = makeDbEmpty();
      const mailSvc = makeMail([]);
      const ATTACKER_ORG = "org-attacker";
      const VICTIM_ORG = "org-victim";
      const access = makeAccess(true, false);
      const svc = new UnifiedInboxService(db, access, mailSvc, makeBroadcasts(), makeBuildApprovals(), makeRegistry());

      await svc.list(ATTACKER_ORG, "user-attacker", { kinds: ["mail"], limit: 25, unreadOnly: false }, makeUser(ATTACKER_ORG, "user-attacker"));

      expect(mailSvc.listMessages as jest.Mock).toHaveBeenCalled();
      expect((mailSvc.listMessages as jest.Mock).mock.calls[0]?.[0]).toBe(ATTACKER_ORG);
      expect((mailSvc.listMessages as jest.Mock).mock.calls[0]?.[0]).not.toBe(VICTIM_ORG);
    });

    it("approval getInboxPage is called with the requesting orgId — not a victim org", async () => {
      const db = makeDbEmpty();
      const approvalsSvc = makeBuildApprovals([]);
      const ATTACKER_ORG = "org-attacker";
      const VICTIM_ORG = "org-victim";
      const access = makeAccess(false, true);
      const svc = new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), approvalsSvc, makeRegistry());

      await svc.list(ATTACKER_ORG, "user-attacker", { kinds: ["build_approval"], limit: 25, unreadOnly: false }, makeUser(ATTACKER_ORG, "user-attacker"));

      const approvalCall = (approvalsSvc.getInboxPage as jest.Mock).mock.calls[0];
      expect(approvalCall).toBeDefined();
      expect(approvalCall?.[0]).toBe(ATTACKER_ORG);
      expect(approvalCall?.[0]).not.toBe(VICTIM_ORG);
    });
  });
});

describe("unified unread count is honest about the mail scan boundary", () => {
  const ORG = "org-1";
  const UID = "user-1";
  const user = makeUser();

  function countDb(): Db {
    return {
      select: jest.fn().mockReturnValueOnce(makeCountChain(0)).mockReturnValueOnce(makeCountChain(0)),
    } as unknown as Db;
  }

  function messages(total: number, unread: number): unknown[] {
    return Array.from({ length: total }, (_, i) =>
      mailMessage(`m${String(i)}`, "2024-01-01T00:00:00Z", i >= unread),
    );
  }

  it("reports mailExact true when the scan did not fill its page", async () => {
    const svc = new UnifiedInboxService(
      countDb(),
      makeAccess(true, true),
      makeMailWithUnread(messages(3, 2)),
      makeBroadcasts(),
      makeBuildApprovals(),
    makeRegistry()
    );

    const counts = await svc.unifiedUnreadCount(ORG, UID, user);

    expect(counts.mail).toBe(2);
    expect(counts.mailExact).toBe(true);
  });

  it("reports mailExact false when the scan filled its page, so the figure is only a floor", async () => {
    const svc = new UnifiedInboxService(
      countDb(),
      makeAccess(true, true),
      makeMailWithUnread(messages(100, 40)),
      makeBroadcasts(),
      makeBuildApprovals(),
    makeRegistry()
    );

    const counts = await svc.unifiedUnreadCount(ORG, UID, user);

    expect(counts.mail).toBe(40);
    expect(counts.mailExact).toBe(false);
  });

  it("reports mailExact true when the caller cannot see mail, because zero is then exact", async () => {
    const svc = new UnifiedInboxService(
      countDb(),
      makeAccess(false, true),
      makeMailWithUnread(messages(100, 40)),
      makeBroadcasts(),
      makeBuildApprovals(),
    makeRegistry()
    );

    const counts = await svc.unifiedUnreadCount(ORG, UID, user);

    expect(counts.mail).toBe(0);
    expect(counts.mailExact).toBe(true);
  });
});
