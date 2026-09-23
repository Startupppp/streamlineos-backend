jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../db/drizzle.module";
import { ApprovalAdapterRegistry } from "../attention/approval-adapter.registry";
import type { ApprovalSourceAdapter } from "../attention/approval-adapter.registry";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { AccessService } from "../access/access.service";
import { UnifiedInboxService } from "./unified-inbox.service";
import { makeBroadcasts, makeUser, ORG, UID, MEMBERSHIP } from "./approval-cursor.spec-fixtures";
import type { MailService } from "../mail/mail.service";
import type { BuildApprovalInboxItem } from "./dto/unified-inbox.schemas";

function makeMail(): MailService {
  return {
    listMessages: jest.fn().mockResolvedValue({ messages: [], nextCursor: null, accountErrors: [] }),
    countUnread: jest.fn().mockResolvedValue({ unread: 0, exact: true }),
    areAllAccountsFresh: jest.fn().mockResolvedValue(true),
  } as unknown as MailService;
}

function item(
  id: number,
  approvalKind: string,
  sourceModule: string,
  deepLink: string | null,
): BuildApprovalInboxItem {
  return {
    kind: "build_approval",
    id,
    approvalKind,
    status: "pending",
    projectId: null,
    ticketId: null,
    dueAt: null,
    dedupKey: `approval:${approvalKind}:${String(id)}`,
    sourceModule,
    subject: `${approvalKind} request`,
    timestamp: new Date("2026-09-20T00:00:00.000Z").toISOString(),
    isRead: false,
    deepLink,
    actor: null,
  };
}

function stubAdapter(
  overrides: Partial<ApprovalSourceAdapter> & Pick<ApprovalSourceAdapter, "module" | "kindLabel">,
): ApprovalSourceAdapter {
  return {
    permission: `${overrides.module}:test:view`,
    supportsAfterCursor: true,
    fetch: () => Promise.resolve([]),
    countPending: () => Promise.resolve(0),
    ...overrides,
  };
}

function makeBuildApprovals(): BuildApprovalsInboxService {
  return {
    getInboxPage: jest.fn().mockResolvedValue([]),
    countPending: jest.fn().mockResolvedValue(0),
  } as unknown as BuildApprovalsInboxService;
}

function makeAccessHolding(granted: ReadonlySet<string>): AccessService {
  return {
    holds: jest.fn((_user: unknown, key: string) => Promise.resolve(granted.has(key))),
    membersWithPermission: jest.fn().mockResolvedValue([]),
  } as unknown as AccessService;
}

function makeService(
  registry: ApprovalAdapterRegistry,
  access: AccessService,
  buildApprovals: BuildApprovalsInboxService = makeBuildApprovals(),
): UnifiedInboxService {
  const db = {
    select: () => ({
      from: () => ({
        leftJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }) }),
        where: () => Promise.resolve([{ cnt: 0 }]),
        innerJoin: () => ({ where: () => Promise.resolve([{ cnt: 0 }]) }),
      }),
    }),
  } as unknown as Db;
  return new UnifiedInboxService(db, access, makeMail(), makeBroadcasts(), buildApprovals, registry);
}

const ALL_APPROVAL_KEYS = new Set([
  "build:approvals:view",
  "hr:leaves:approve",
  "timesheets:approvals:view",
  "mail:inbox:view",
]);

describe("attention adapters carry their own destination", () => {
  it("delivers the deep link the owning module supplied, for every adapter kind", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        fetch: () => Promise.resolve([item(7, "leave", "hr", "/hr/leaves?tab=pending")]),
      }),
    );
    registry.register(
      stubAdapter({
        module: "timesheets",
        kindLabel: "timesheet",
        permission: "timesheets:approvals:view",
        fetch: () => Promise.resolve([item(9, "timesheet", "timesheets", "/timesheets/approvals")]),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(ALL_APPROVAL_KEYS));
    const page = await svc.list(ORG, UID, { limit: 25, kinds: ["build_approval"], unreadOnly: false }, makeUser());

    const byKind = new Map(
      page.items
        .filter((i): i is BuildApprovalInboxItem => i.kind === "build_approval")
        .map((i) => [i.approvalKind, i.deepLink]),
    );
    expect(byKind.get("leave")).toBe("/hr/leaves?tab=pending");
    expect(byKind.get("timesheet")).toBe("/timesheets/approvals");
  });

  it("CONTROL: an adapter that supplies no deep link still delivers its item, with a null link", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        fetch: () => Promise.resolve([item(7, "leave", "hr", null)]),
      }),
    );

    const svc = makeService(registry, makeAccessHolding(ALL_APPROVAL_KEYS));
    const page = await svc.list(ORG, UID, { limit: 25, kinds: ["build_approval"], unreadOnly: false }, makeUser());

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.deepLink).toBeNull();
  });

  it("module filtering reaches only the owning approval adapter", async () => {
    const hrFetch = jest.fn().mockResolvedValue([
      item(7, "leave", "hr", "/hr/leaves?tab=pending"),
    ]);
    const timesheetFetch = jest.fn().mockResolvedValue([
      item(9, "timesheet", "timesheets", "/timesheets/approvals"),
    ]);
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        fetch: hrFetch,
      }),
    );
    registry.register(
      stubAdapter({
        module: "timesheets",
        kindLabel: "timesheet",
        permission: "timesheets:approvals:view",
        fetch: timesheetFetch,
      }),
    );

    const svc = makeService(registry, makeAccessHolding(ALL_APPROVAL_KEYS));
    const page = await svc.list(
      ORG,
      UID,
      {
        limit: 25,
        kinds: ["build_approval"],
        unreadOnly: false,
        module: "hr",
      },
      makeUser(),
    );

    expect(hrFetch).toHaveBeenCalled();
    expect(timesheetFetch).not.toHaveBeenCalled();
    expect(page.items.map((entry) => entry.sourceModule)).toEqual(["hr"]);
  });
});

describe("the unread badge counts every attention source, not only Build", () => {
  it("sums the pending count of every adapter the actor may see", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        countPending: () => Promise.resolve(4),
      }),
    );
    registry.register(
      stubAdapter({
        module: "timesheets",
        kindLabel: "timesheet",
        permission: "timesheets:approvals:view",
        countPending: () => Promise.resolve(3),
      }),
    );
    const buildApprovals = makeBuildApprovals();
    (buildApprovals.countPending as jest.Mock).mockResolvedValue(2);

    const svc = makeService(registry, makeAccessHolding(ALL_APPROVAL_KEYS), buildApprovals);
    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.approval).toBe(9);
  });

  it("omits an adapter the actor has no permission for", async () => {
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        countPending: () => Promise.resolve(4),
      }),
    );
    registry.register(
      stubAdapter({
        module: "timesheets",
        kindLabel: "timesheet",
        permission: "timesheets:approvals:view",
        countPending: () => Promise.resolve(3),
      }),
    );
    const buildApprovals = makeBuildApprovals();
    (buildApprovals.countPending as jest.Mock).mockResolvedValue(2);

    const svc = makeService(
      registry,
      makeAccessHolding(new Set(["build:approvals:view", "hr:leaves:approve"])),
      buildApprovals,
    );
    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(count.approval).toBe(6);
  });

  it("never asks an adapter to count for a principal with no membership", async () => {
    const countPending = jest.fn().mockResolvedValue(5);
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        countPending,
      }),
    );

    const svc = makeService(registry, makeAccessHolding(ALL_APPROVAL_KEYS));
    const tokenPrincipal = {
      ...makeUser(),
      principal: { kind: "account-only" as const },
    };
    const count = await svc.unifiedUnreadCount(ORG, UID, tokenPrincipal);

    expect(countPending).not.toHaveBeenCalled();
    expect(count.approval).toBe(0);
  });

  it("CONTROL: the same actor with a membership does reach the adapter", async () => {
    const countPending = jest.fn().mockResolvedValue(5);
    const registry = new ApprovalAdapterRegistry();
    registry.register(
      stubAdapter({
        module: "hr",
        kindLabel: "leave",
        permission: "hr:leaves:approve",
        countPending,
      }),
    );

    const svc = makeService(registry, makeAccessHolding(ALL_APPROVAL_KEYS));
    const count = await svc.unifiedUnreadCount(ORG, UID, makeUser());

    expect(countPending).toHaveBeenCalledWith(ORG, UID, MEMBERSHIP);
    expect(count.approval).toBe(5);
  });
});
