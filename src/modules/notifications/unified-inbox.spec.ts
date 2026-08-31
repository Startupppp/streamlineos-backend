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

function makeChain(rows: unknown[] = []): ReturnType<typeof makeChain> {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["from", "leftJoin", "where", "orderBy", "limit", "offset"]) {
    chain[method] = jest.fn().mockImplementation(
      () => (method === "limit" ? Promise.resolve(rows) : chain),
    );
  }
  return chain as ReturnType<typeof makeChain>;
}

function makeDb(rows: unknown[] = []): Db {
  return {
    select: jest.fn().mockReturnValue(makeChain(rows)),
  } as unknown as Db;
}

function makeAccess(
  hasMailPermission: boolean,
  hasBuildApprovalsPermission = false,
): AccessService {
  return {
    holds: jest.fn().mockImplementation((_user: unknown, key: string) => {
      if (key === "mail:inbox:view") return Promise.resolve(hasMailPermission);
      if (key === "build:approvals:view") return Promise.resolve(hasBuildApprovalsPermission);
      return Promise.resolve(false);
    }),
  } as unknown as AccessService;
}

function makeMail(messages: unknown[] = [], nextCursor: string | null = null): MailService {
  return {
    listMessages: jest.fn().mockResolvedValue({ messages, nextCursor, accountErrors: [] }),
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

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "user-1",
    orgId: "org-1",
    email: "u@example.com",
    sessionId: "s-1",
    principal: { kind: "human-session" } as CurrentUserContext["principal"],
    ...overrides,
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

function mailMessage(id: string, date: string) {
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
    isRead: false,
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

describe("UnifiedInboxService", () => {
  const org = "org-1";
  const uid = "user-1";
  const user = makeUser();

  beforeEach(() => jest.clearAllMocks());

  describe("union assembly", () => {
    it("merges notifications and broadcasts sorted by timestamp DESC", async () => {
      const olderDate = new Date("2024-01-01T10:00:00Z");
      const newerDate = new Date("2024-01-02T10:00:00Z");

      const db = makeDb([notifRow(1, olderDate)]);
      const broadcasts = makeBroadcasts([broadcastRow(5, newerDate)]);
      const mail = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mail, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 10, kinds: ["notification", "broadcast"] }, user);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.kind).toBe("broadcast");
      expect(result.items[1]?.kind).toBe("notification");
    });

    it("includes mail items when caller has permission", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mail = makeMail([mailMessage("msg-1", "2024-01-03T10:00:00Z")]);
      const access = makeAccess(true);

      const svc = new UnifiedInboxService(db, access, mail, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 10 }, user);

      const mailItems = result.items.filter((i) => i.kind === "mail");
      expect(mailItems).toHaveLength(1);
      expect(mailItems[0]?.id).toBe("msg-1");
    });
  });

  describe("permission filter", () => {
    it("excludes mail items when caller lacks mail:inbox:view", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail([mailMessage("msg-1", "2024-01-03T10:00:00Z")]);
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 10 }, user);

      const mailItems = result.items.filter((i) => i.kind === "mail");
      expect(mailItems).toHaveLength(0);

      const mailSource = result.sources.find((s) => s.kind === "mail");
      expect(mailSource?.included).toBe(false);
      expect(mailSource?.reason).toBe("no permission: mail:inbox:view");
    });

    it("never calls mailService.listMessages when caller lacks permission", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      await svc.list(org, uid, { limit: 10 }, user);

      expect((mailSvc.listMessages as jest.Mock)).not.toHaveBeenCalled();
    });

    it("permission is checked against the caller derived from CurrentUser, not a client param", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      await svc.list(org, uid, { limit: 10 }, user);

      const holdsMock = access.holds as jest.Mock;
      expect(holdsMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: uid, orgId: org }),
        "mail:inbox:view",
      );
    });
  });

  describe("hard cap", () => {
    it("response is limited to at most 100 items even when limit param exceeds 100", async () => {
      const rows = Array.from({ length: 102 }, (_, i) =>
        notifRow(102 - i, new Date(Date.now() - i * 1000)),
      );
      const db = makeDb(rows);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 200 }, user);

      expect(result.items.length).toBeLessThanOrEqual(100);
    });

    it("returns a non-null nextCursor when the source had more than limit items", async () => {
      const rows = Array.from({ length: 6 }, (_, i) =>
        notifRow(6 - i, new Date(Date.now() - i * 1000)),
      );
      const db = makeDb(rows);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 5 }, user);

      expect(result.items).toHaveLength(5);
      expect(result.nextCursor).not.toBeNull();
    });

    it("returns null nextCursor when all sources are exhausted", async () => {
      const db = makeDb([notifRow(1, new Date())]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 25 }, user);

      expect(result.nextCursor).toBeNull();
    });
  });

  describe("cursor correctness", () => {
    it("cursor encodes the last notification id when notifications appear in the page", async () => {
      const rows = [
        notifRow(10, new Date("2024-01-10T00:00:00Z")),
        notifRow(9, new Date("2024-01-09T00:00:00Z")),
        notifRow(8, new Date("2024-01-08T00:00:00Z")),
        notifRow(7, new Date("2024-01-07T00:00:00Z")),
        notifRow(6, new Date("2024-01-06T00:00:00Z")),
        notifRow(5, new Date("2024-01-05T00:00:00Z")),
      ];
      const db = makeDb(rows);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 5 }, user);

      expect(result.nextCursor).not.toBeNull();
      const state = decodeInboxCursor(result.nextCursor!);
      expect(state.n).toBe(6);
    });

    it("cursor.n stays unchanged when no notifications appear in page (broadcasts only)", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([
        broadcastRow(10, new Date("2024-01-10T00:00:00Z")),
        broadcastRow(9, new Date("2024-01-09T00:00:00Z")),
        broadcastRow(8, new Date("2024-01-08T00:00:00Z")),
        broadcastRow(7, new Date("2024-01-07T00:00:00Z")),
        broadcastRow(6, new Date("2024-01-06T00:00:00Z")),
        broadcastRow(5, new Date("2024-01-05T00:00:00Z")),
      ]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());
      const result = await svc.list(org, uid, { limit: 5 }, user);

      expect(result.nextCursor).not.toBeNull();
      const state = decodeInboxCursor(result.nextCursor!);
      expect(state.n).toBeNull();
      expect(state.b).toBe(6);
    });

    it("cursor never has undefined fields — all fields serialise as null or a value", async () => {
      const db = makeDb([notifRow(5, new Date())]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals());

      const resultFull = await svc.list(org, uid, { limit: 1 }, user);
      if (resultFull.nextCursor) {
        const raw = Buffer.from(resultFull.nextCursor, "base64url").toString("utf8");
        const parsed: unknown = JSON.parse(raw);
        expect(parsed).toEqual(expect.objectContaining({ n: expect.anything() }));
        expect(JSON.stringify(parsed)).not.toContain("undefined");
      }

      const resultEmpty = await svc.list(org, uid, { limit: 25 }, user);
      expect(resultEmpty.nextCursor).toBeNull();
    });

    it("cursor encodes the last approval id when approvals appear in the page", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false, true);
      const approvalsRows = [
        approvalRow(10, new Date("2024-01-10T00:00:00Z")),
        approvalRow(9, new Date("2024-01-09T00:00:00Z")),
        approvalRow(8, new Date("2024-01-08T00:00:00Z")),
        approvalRow(7, new Date("2024-01-07T00:00:00Z")),
        approvalRow(6, new Date("2024-01-06T00:00:00Z")),
        approvalRow(5, new Date("2024-01-05T00:00:00Z")),
      ];

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, makeBuildApprovals(approvalsRows));
      const result = await svc.list(org, uid, { limit: 5 }, user);

      expect(result.nextCursor).not.toBeNull();
      const state = decodeInboxCursor(result.nextCursor!);
      expect(state.a).toBe(6);
    });
  });

  describe("build_approval source", () => {
    it("always reports build_approval as not included when caller lacks build:approvals:view", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(true, false);
      const approvalsSvc = makeBuildApprovals();

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, approvalsSvc);
      const result = await svc.list(org, uid, { limit: 10 }, user);

      const approvalSource = result.sources.find((s) => s.kind === "build_approval");
      expect(approvalSource?.included).toBe(false);
      expect(approvalSource?.reason).toBe("no permission: build:approvals:view");
    });

    it("never calls buildApprovals.getInboxPage when caller lacks build:approvals:view", async () => {
      const db = makeDb([]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false, false);
      const approvalsSvc = makeBuildApprovals();

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, approvalsSvc);
      await svc.list(org, uid, { limit: 10 }, user);

      expect((approvalsSvc.getInboxPage as jest.Mock)).not.toHaveBeenCalled();
    });

    it("includes build_approval items merged in timestamp order when caller has permission", async () => {
      const olderDate = new Date("2024-01-01T10:00:00Z");
      const newerDate = new Date("2024-01-03T10:00:00Z");

      const db = makeDb([notifRow(1, olderDate)]);
      const broadcasts = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(false, true);
      const approvalsSvc = makeBuildApprovals([approvalRow(5, newerDate)]);

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcasts, approvalsSvc);
      const result = await svc.list(org, uid, { limit: 10 }, user);

      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.kind).toBe("build_approval");
      expect(result.items[1]?.kind).toBe("notification");

      const approvalSource = result.sources.find((s) => s.kind === "build_approval");
      expect(approvalSource?.included).toBe(true);
      expect(approvalSource?.reason).toBeNull();
    });
  });

  describe("kinds filter", () => {
    it("only fetches notification source when kinds=['notification']", async () => {
      const db = makeDb([]);
      const broadcastsSvc = makeBroadcasts([]);
      const mailSvc = makeMail();
      const access = makeAccess(true, true);
      const approvalsSvc = makeBuildApprovals();

      const svc = new UnifiedInboxService(db, access, mailSvc, broadcastsSvc, approvalsSvc);
      await svc.list(org, uid, { limit: 10, kinds: ["notification"] }, user);

      expect((broadcastsSvc.listInboxPage as jest.Mock)).not.toHaveBeenCalled();
      expect((mailSvc.listMessages as jest.Mock)).not.toHaveBeenCalled();
      expect((approvalsSvc.getInboxPage as jest.Mock)).not.toHaveBeenCalled();
    });
  });

  describe("exhaustive kind switch", () => {
    it("inboxItemKind returns the correct label for each known kind", () => {
      const db = makeDb([]);
      const svc = new UnifiedInboxService(
        db,
        makeAccess(false),
        makeMail(),
        makeBroadcasts([]),
        makeBuildApprovals(),
      );

      const notif = { kind: "notification" as const } as Parameters<typeof svc.inboxItemKind>[0];
      const bc = { kind: "broadcast" as const } as Parameters<typeof svc.inboxItemKind>[0];
      const mail = { kind: "mail" as const } as Parameters<typeof svc.inboxItemKind>[0];
      const approval = { kind: "build_approval" as const } as Parameters<typeof svc.inboxItemKind>[0];

      expect(svc.inboxItemKind(notif)).toBe("notification");
      expect(svc.inboxItemKind(bc)).toBe("broadcast");
      expect(svc.inboxItemKind(mail)).toBe("mail");
      expect(svc.inboxItemKind(approval)).toBe("build_approval");
    });
  });
});
