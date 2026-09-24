jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { ApprovalInboxRow } from "../build/approvals/build-approvals-inbox.service";
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

function makeAccess(mailPerm = true, approvalPerm = true): AccessService {
  return {
    holds: jest.fn().mockImplementation((_user: unknown, key: string) => {
      if (key === "mail:inbox:view") return Promise.resolve(mailPerm);
      if (key === "build:approvals:view") return Promise.resolve(approvalPerm);
      return Promise.resolve(false);
    }),
  } as unknown as AccessService;
}

type BroadcastSeed = {
  id: number;
  title: string;
  message: string;
  sentAt: Date;
};

function makeBroadcasts(seeds: BroadcastSeed[] = []): BroadcastsService {
  const rows = seeds.map((s) => ({
    id: s.id,
    title: s.title,
    message: s.message,
    type: "INFO",
    priority: "NORMAL",
    category: "SYSTEM",
    sentAt: s.sentAt,
    createdAt: s.sentAt,
  }));
  return { listInboxPage: jest.fn().mockResolvedValue(rows) } as unknown as BroadcastsService;
}

function makeBuildApprovals(seeds: ApprovalInboxRow[] = []): BuildApprovalsInboxService {
  return {
    getInboxPage: jest.fn().mockResolvedValue(seeds),
  } as unknown as BuildApprovalsInboxService;
}

function makeMail(): MailService {
  return {
    areAllAccountsFresh: jest.fn().mockResolvedValue(true),
    listMessages: jest
      .fn()
      .mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
  } as unknown as MailService;
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


function makeRegistry() {
  return { list: jest.fn().mockReturnValue([]), register: jest.fn() } as unknown as import("../attention/approval-adapter.registry").ApprovalAdapterRegistry;
}
describe("unified inbox — triage filter excludes non-active sources", () => {
  const user = makeUser();

  it("BITE: triage=later excludes mail with an unsupported reason", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["mail"], unreadOnly: false, triage: "later" },
      user,
    );

    const mailSource = sourceOf(result, "mail");
    expect(mailSource.included).toBe(false);
    expect(mailSource.reason).toBe("unsupported: triage (mail has no archive state)");
  });

  it("BITE: triage=done excludes mail with an unsupported reason", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["mail"], unreadOnly: false, triage: "done" },
      user,
    );

    const mailSource = sourceOf(result, "mail");
    expect(mailSource.included).toBe(false);
    expect(mailSource.reason).toContain("unsupported: triage");
  });

  it("triage=later excludes broadcast items", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts([
        { id: 1, title: "Hello", message: "body", sentAt: new Date("2026-03-01T10:00:00Z") },
      ]),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["broadcast"], unreadOnly: false, triage: "later" },
      user,
    );

    expect(result.items.filter((i) => i.kind === "broadcast")).toHaveLength(0);
    const broadcastSource = sourceOf(result, "broadcast");
    expect(broadcastSource.included).toBe(false);
  });

  it("triage=done excludes build approvals", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      makeBuildApprovals([approvalRow(5, new Date("2026-03-01T10:00:00Z"))]), makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["build_approval"], unreadOnly: false, triage: "done" },
      user,
    );

    expect(result.items.filter((i) => i.kind === "build_approval")).toHaveLength(0);
    const approvalSource = sourceOf(result, "build_approval");
    expect(approvalSource.included).toBe(false);
  });

  it("triage=active (default) does not exclude any source", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts([
        { id: 1, title: "Hello", message: "body", sentAt: new Date("2026-03-01T10:00:00Z") },
      ]),
      makeBuildApprovals([approvalRow(5, new Date("2026-03-01T09:00:00Z"))]), makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["broadcast", "build_approval"], unreadOnly: false, triage: "active" },
      user,
    );

    expect(sourceOf(result, "broadcast").included).toBe(true);
    expect(sourceOf(result, "build_approval").included).toBe(true);
  });
});

describe("unified inbox — q filter on broadcasts", () => {
  const user = makeUser();

  it("BITE: q filter removes broadcasts whose subject does not contain the term", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts([
        { id: 1, title: "Hello World", message: "some body", sentAt: new Date("2026-03-01T10:00:00Z") },
        { id: 2, title: "Unrelated Title", message: "other content", sentAt: new Date("2026-03-01T09:00:00Z") },
      ]),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["broadcast"], unreadOnly: false, q: "hello" },
      user,
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual(["broadcast:1"]);
  });

  it("q filter matches on message body when subject does not match", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts([
        { id: 3, title: "No match here", message: "body contains NEEDLE", sentAt: new Date("2026-03-01T10:00:00Z") },
        { id: 4, title: "Also no match", message: "nothing relevant", sentAt: new Date("2026-03-01T09:00:00Z") },
      ]),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["broadcast"], unreadOnly: false, q: "needle" },
      user,
    );

    expect(result.items.map((i) => i.dedupKey)).toEqual(["broadcast:3"]);
  });

  it("q filter is case-insensitive", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts([
        { id: 5, title: "SCREAMING CASE TITLE", message: "body", sentAt: new Date("2026-03-01T10:00:00Z") },
      ]),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["broadcast"], unreadOnly: false, q: "screaming case" },
      user,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].dedupKey).toBe("broadcast:5");
  });

  it("empty items list when q matches nothing", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts([
        { id: 6, title: "Completely unrelated", message: "body here", sentAt: new Date("2026-03-01T10:00:00Z") },
      ]),
      makeBuildApprovals(),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["broadcast"], unreadOnly: false, q: "nomatch" },
      user,
    );

    expect(result.items).toHaveLength(0);
  });
});

describe("unified inbox — approval adapter seam", () => {
  const user = makeUser();

  it("BITE: build approval items carry the approval:build: dedupKey prefix", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      makeBuildApprovals([approvalRow(42, new Date("2026-03-01T10:00:00Z"))]), makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["build_approval"], unreadOnly: false },
      user,
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].dedupKey).toBe("approval:build:42");
  });

  it("BITE: build approval items expose approvalKind=build", async () => {
    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      makeBuildApprovals([approvalRow(42, new Date("2026-03-01T10:00:00Z"))]), makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["build_approval"], unreadOnly: false },
      user,
    );

    const item = result.items[0];
    expect(item.kind).toBe("build_approval");
    if (item.kind === "build_approval") {
      expect(item.approvalKind).toBe("build");
    }
  });

  it("dedup keys from multiple approval items are all unique and carry the build prefix", async () => {
    const seeds: ApprovalInboxRow[] = [
      approvalRow(10, new Date("2026-03-01T10:00:00Z")),
      approvalRow(20, new Date("2026-03-01T09:00:00Z")),
      approvalRow(30, new Date("2026-03-01T08:00:00Z")),
    ];

    const svc = new UnifiedInboxService(
      makeDb(),
      makeAccess(),
      makeMail(),
      makeBroadcasts(),
      makeBuildApprovals(seeds),
    makeRegistry()
    );

    const result = await svc.list(
      ORG,
      UID,
      { limit: 10, kinds: ["build_approval"], unreadOnly: false },
      user,
    );

    const keys = result.items.map((i) => i.dedupKey);
    expect(keys.every((k) => k.startsWith("approval:build:"))).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });
});
