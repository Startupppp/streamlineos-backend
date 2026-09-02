process.env.APP_URL ??= "http://localhost:1000";

import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ApprovalsService } from "./approvals.service";
import type { AccessService } from "../../access/access.service";
import type { AuditService } from "../../../common/audit/audit.service";
import type { ChatChannelsService } from "../../chat/chat-channels.service";
import type { ChatMessagesService } from "../../chat/chat-messages.service";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

const makeApprovalRow = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 1,
  orgId: "org-1",
  projectId: 1,
  entityType: "ticket",
  entityId: 1,
  title: "Review this",
  approverId: "approver-1",
  approverMembershipId: 1,
  requestedById: "user-1",
  status: "pending",
  level: 1,
  dueAt: null,
  decidedAt: null,
  decisionComment: null,
  deletedAt: null,
  createdBy: "user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockDb = {
  query: {
    projectApprovals: { findFirst: jest.fn() },
    projects: { findFirst: jest.fn() },
  },
} as unknown as Db;

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockAccess = {
  holds: jest.fn(),
  resolveUserPermissions: jest.fn(),
} as unknown as AccessService;
const mockChatChannels = { getOrCreateEntityChannel: jest.fn() } as unknown as ChatChannelsService;
const mockChatMessages = { sendSystemMessage: jest.fn() } as unknown as ChatMessagesService;

beforeEach(() => {
  jest.resetAllMocks();
});

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-2",
  orgId: "org-1",
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
  ...overrides,
});

describe("ApprovalsService.createApproval", () => {
  it("throws BadRequestException when approverId equals the requesting userId", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    await expect(
      svc.createApproval(makeUser({ userId: "user-1", orgId: "org-1" }), 1, {
        entityType: "task",
        entityId: 1,
        title: "Self-review",
        approverId: "user-1",
      }),
    ).rejects.toThrow(BadRequestException);
    expect((mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst).not.toHaveBeenCalled();
  });
});

describe("ApprovalsService.decideApproval", () => {
  it("throws NotFoundException (not-leak) when caller is not the assigned approver and lacks manage permission", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(
      makeApprovalRow({ approverId: "approver-1", approverMembershipId: 999 }),
    );
    (mockAccess.holds as jest.Mock).mockResolvedValue(false);

    await expect(
      svc.decideApproval(makeUser(), 1, 1, { decision: "approved" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("allows a caller with projects:approvals:manage to decide even when not the assigned approver", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    const approval = makeApprovalRow({ approverId: "approver-1", approverMembershipId: 999, status: "pending" });
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(approval);
    (mockAccess.holds as jest.Mock).mockResolvedValue(true);
    const updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...approval, status: "approved", decidedAt: new Date() }]),
    };
    (mockDb as unknown as { update: jest.Mock }).update = jest.fn().mockReturnValue(updateChain);

    await expect(
      svc.decideApproval(makeUser(), 1, 1, { decision: "approved" }),
    ).resolves.toBeDefined();
  });

  it("throws ConflictException when the approval has already been decided", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(
      makeApprovalRow({ approverId: "user-2", status: "approved" }),
    );

    await expect(
      svc.decideApproval(makeUser(), 1, 1, { decision: "rejected" }),
    ).rejects.toThrow(ConflictException);
  });

  it("throws ConflictException when the approval status is rejected (already decided)", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(
      makeApprovalRow({ approverId: "user-2", status: "rejected" }),
    );

    await expect(
      svc.decideApproval(makeUser(), 1, 1, { decision: "approved" }),
    ).rejects.toThrow(ConflictException);
  });

  it("throws NotFoundException when no approval row exists (cross-tenant/BOLA)", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(undefined);

    await expect(
      svc.decideApproval(makeUser({ orgId: "org-2" }), 1, 99, { decision: "approved" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("revoked-member: caller whose membershipId no longer matches approverMembershipId is denied without manage permission", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(
      makeApprovalRow({ approverMembershipId: 999, status: "pending" }),
    );
    (mockAccess.holds as jest.Mock).mockResolvedValue(false);

    await expect(
      svc.decideApproval(makeUser({ principal: humanSessionPrincipal(1, false) }), 1, 1, { decision: "approved" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("approverMembershipId match: caller whose membershipId matches approverMembershipId can decide without manage permission", async () => {
    const svc = new ApprovalsService(
      mockDb,
      mockAudit,
      mockAccess,
      mockChatChannels,
      mockChatMessages,
    );
    const approval = makeApprovalRow({ approverMembershipId: 1, status: "pending" });
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(approval);
    const updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...approval, status: "approved", decidedAt: new Date() }]),
    };
    (mockDb as unknown as { update: jest.Mock }).update = jest.fn().mockReturnValue(updateChain);

    await expect(
      svc.decideApproval(makeUser({ principal: humanSessionPrincipal(1, false) }), 1, 1, { decision: "approved" }),
    ).resolves.toBeDefined();
    expect(mockAccess.holds).not.toHaveBeenCalled();
  });
});

function makeGateDbNonMember(): Db {
  const membershipLimit = jest.fn().mockResolvedValue([]);
  const membershipWhere = jest.fn().mockReturnValue({ limit: membershipLimit });
  const membershipInnerJoin = jest.fn().mockReturnValue({ where: membershipWhere });
  const membershipFrom = jest.fn().mockReturnValue({ innerJoin: membershipInnerJoin });

  const teamInnerJoin2 = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });
  const teamInnerJoin1 = jest.fn().mockReturnValue({ innerJoin: teamInnerJoin2 });
  const teamFrom = jest.fn().mockReturnValue({ innerJoin: teamInnerJoin1 });

  const select = jest.fn()
    .mockReturnValueOnce({ from: membershipFrom })
    .mockReturnValueOnce({ from: teamFrom });

  return {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }),
      },
      projectApprovals: { findFirst: jest.fn() },
    },
    select,
  } as unknown as Db;
}

function makeGateDbMember(): Db {
  const membershipLimit = jest.fn().mockResolvedValue([{ role: "MEMBER" }]);
  const membershipWhere = jest.fn().mockReturnValue({ limit: membershipLimit });
  const membershipInnerJoin = jest.fn().mockReturnValue({ where: membershipWhere });
  const membershipFrom = jest.fn().mockReturnValue({ innerJoin: membershipInnerJoin });

  const listWhere = jest.fn().mockReturnValue({
    orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
  });
  const listFrom = jest.fn().mockReturnValue({ where: listWhere });

  const select = jest.fn()
    .mockReturnValueOnce({ from: membershipFrom })
    .mockReturnValue({ from: listFrom });

  return {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, managerMembershipId: null }),
      },
      projectApprovals: { findFirst: jest.fn() },
    },
    select,
  } as unknown as Db;
}

describe("ApprovalsService — project membership gate (listApprovals)", () => {
  it("rejects a non-member (isOrgOwner=false, no build:manage, no projectMembers row)", async () => {
    const db = makeGateDbNonMember();
    const access = {
      holds: jest.fn(),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
    } as unknown as AccessService;
    const svc = new ApprovalsService(db, mockAudit, access, mockChatChannels, mockChatMessages);

    await expect(
      svc.listApprovals(makeUser({ isOrgOwner: false, principal: humanSessionPrincipal(42, false) }), 1, {}),
    ).rejects.toThrow(ForbiddenException);
  });

  it("allows a direct project member past the gate", async () => {
    const db = makeGateDbMember();
    const access = {
      holds: jest.fn(),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
    } as unknown as AccessService;
    const svc = new ApprovalsService(db, mockAudit, access, mockChatChannels, mockChatMessages);

    await expect(
      svc.listApprovals(makeUser({ isOrgOwner: false, principal: humanSessionPrincipal(42, false) }), 1, {}),
    ).resolves.toBeDefined();
  });
});

describe("ApprovalsService — project membership gate (createApproval)", () => {
  it("rejects a non-member before inserting an approval", async () => {
    const db = makeGateDbNonMember();
    const access = {
      holds: jest.fn(),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
    } as unknown as AccessService;
    const svc = new ApprovalsService(db, mockAudit, access, mockChatChannels, mockChatMessages);

    await expect(
      svc.createApproval(
        makeUser({ userId: "user-2", isOrgOwner: false, principal: humanSessionPrincipal(42, false) }),
        1,
        { entityType: "ticket", entityId: 5, title: "Gate test", approverId: "approver-1" },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("gate is load-bearing: resolveUserPermissions is called for non-owner callers", async () => {
    const db = makeGateDbNonMember();
    const access = {
      holds: jest.fn(),
      resolveUserPermissions: jest.fn().mockResolvedValue(new Set()),
    } as unknown as AccessService;
    const svc = new ApprovalsService(db, mockAudit, access, mockChatChannels, mockChatMessages);

    const u = makeUser({ userId: "user-2", isOrgOwner: false, principal: humanSessionPrincipal(42, false) });
    await expect(
      svc.createApproval(u, 1, {
        entityType: "ticket",
        entityId: 5,
        title: "Gate test",
        approverId: "approver-1",
      }),
    ).rejects.toThrow(ForbiddenException);
    expect((access.resolveUserPermissions as jest.Mock)).toHaveBeenCalledWith("org-1", "user-2");
  });
});
