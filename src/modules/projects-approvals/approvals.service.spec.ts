import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { ApprovalsService } from "./approvals.service";
import type { AccessService } from "../access/access.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { ChatChannelsService } from "../chat/chat-channels.service";
import type { ChatMessagesService } from "../chat/chat-messages.service";
import type { Db } from "../../db/drizzle.module";

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
const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;
const mockChatChannels = { getOrCreateEntityChannel: jest.fn() } as unknown as ChatChannelsService;
const mockChatMessages = { sendSystemMessage: jest.fn() } as unknown as ChatMessagesService;

beforeEach(() => {
  jest.resetAllMocks();
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
      svc.createApproval("org-1", "user-1", 1, {
        entityType: "ticket",
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
      makeApprovalRow({ approverId: "approver-1" }),
    );
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(new Map());

    await expect(
      svc.decideApproval("org-1", "user-2", 1, 1, { decision: "approved" }),
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
    const approval = makeApprovalRow({ approverId: "approver-1", status: "pending" });
    (mockDb as unknown as { query: { projectApprovals: { findFirst: jest.Mock } } }).query.projectApprovals.findFirst.mockResolvedValue(approval);
    (mockAccess.resolveUserPermissions as jest.Mock).mockResolvedValue(
      new Map([["projects:approvals:manage", "all"]]),
    );
    const updateChain = {
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ ...approval, status: "approved", decidedAt: new Date() }]),
    };
    (mockDb as unknown as { update: jest.Mock }).update = jest.fn().mockReturnValue(updateChain);

    await expect(
      svc.decideApproval("org-1", "user-2", 1, 1, { decision: "approved" }),
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
      svc.decideApproval("org-1", "user-2", 1, 1, { decision: "rejected" }),
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
      svc.decideApproval("org-1", "user-2", 1, 1, { decision: "approved" }),
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
      svc.decideApproval("org-2", "user-2", 1, 99, { decision: "approved" }),
    ).rejects.toThrow(NotFoundException);
  });
});
