process.env.APP_URL ??= "http://localhost:1000";

import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { ChatChannelsService } from "../../chat/chat-channels.service";
import { ChatMessagesService } from "../../chat/chat-messages.service";
import { assertProjectWriteAccess } from "../core";
import { projectAccessRow, type ProjectAccessRow } from "../__tests__/project-access-doubles";
import { ApprovalsService } from "./approvals.service";

jest.mock("../core/project-crud/project-access", () => ({
  assertProjectAccess: jest.fn(),
  assertProjectWriteAccess: jest.fn(),
  authorizeApprovalDecision: jest.requireActual("../core/project-crud/project-access").authorizeApprovalDecision,
}));

const ORG_ID = "org-1";
const PROJECT_ID = 7;
const APPROVAL_ID = 42;
const MEMBERSHIP_ID = 7;

const user: CurrentUserContext = {
  userId: "user-7",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
};

function approvalRow(approverMembershipId = 999, status = "pending") {
  return {
    id: APPROVAL_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    entityType: "ticket",
    entityId: 1,
    title: "Review this",
    approverMembershipId,
    requestedById: "user-1",
    status,
    level: 1,
    dueAt: null,
    decidedAt: null,
    decisionComment: null,
    deletedAt: null,
    createdBy: "user-1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe("ApprovalsService project authorization", () => {
  const findFirst = jest.fn();
  const returning = jest.fn();
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  const projectRows = jest.fn<Promise<ProjectAccessRow[]>, []>();
  const select = jest.fn(() => ({ from: () => ({ where: () => ({ limit: projectRows }) }) }));
  const db = { query: { projectApprovals: { findFirst } }, update, select };
  const audit = { log: jest.fn() };
  const access = {
    holds: jest.fn(),
    scopeFor: jest.fn(),
  };
  const chatChannels = { getOrCreateEntityChannel: jest.fn() };
  const chatMessages = { sendSystemMessage: jest.fn() };
  let service: ApprovalsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.mocked(assertProjectWriteAccess).mockResolvedValue(undefined);
    select.mockImplementation(() => ({ from: () => ({ where: () => ({ limit: projectRows }) }) }));
    projectRows.mockResolvedValue([projectAccessRow()]);
    access.scopeFor.mockImplementation(async (_actor: CurrentUserContext, key: string) =>
      key === "build:view" ? "own" : "none",
    );
    findFirst.mockResolvedValue(approvalRow());
    returning.mockResolvedValue([approvalRow()]);
    where.mockReturnValue({ returning });
    set.mockReturnValue({ where });
    update.mockReturnValue({ set });
    access.holds.mockResolvedValue(true);

    const testingModule = await Test.createTestingModule({
      providers: [
        ApprovalsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: audit },
        { provide: AccessService, useValue: access },
        { provide: ChatChannelsService, useValue: chatChannels },
        { provide: ChatMessagesService, useValue: chatMessages },
      ],
    }).compile();
    service = testingModule.get(ApprovalsService);
  });

  it("denies a manage-permission holder without project access before deciding", async () => {
    await expect(
      service.decideApproval(user, PROJECT_ID, APPROVAL_ID, { decision: "approved" }),
    ).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it("lets a manage-permission holder who is a project member decide, the positive pair of the denial above", async () => {
    projectRows.mockResolvedValue([projectAccessRow({ memberRole: "MEMBER" })]);

    await expect(
      service.decideApproval(user, PROJECT_ID, APPROVAL_ID, { decision: "approved" }),
    ).resolves.toBeDefined();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("allows the designated approver without the manage permission or project membership", async () => {
    findFirst.mockResolvedValue(approvalRow(MEMBERSHIP_ID));

    await expect(
      service.decideApproval(user, PROJECT_ID, APPROVAL_ID, { decision: "approved" }),
    ).resolves.toBeDefined();
    expect(access.holds).not.toHaveBeenCalled();
  });

  it("refuses even the designated approver with 409 once the project is archived, because a locked project takes no decisions", async () => {
    findFirst.mockResolvedValue(approvalRow(MEMBERSHIP_ID));
    projectRows.mockResolvedValue([projectAccessRow({ state: "ARCHIVED" })]);

    await expect(
      service.decideApproval(user, PROJECT_ID, APPROVAL_ID, { decision: "approved" }),
    ).rejects.toThrow(ConflictException);
    expect(update).not.toHaveBeenCalled();
  });

  it("denies approval updates before loading or writing when project write access fails", async () => {
    jest.mocked(assertProjectWriteAccess).mockRejectedValue(new ForbiddenException());

    await expect(
      service.updateApproval(user, PROJECT_ID, APPROVAL_ID, { status: "cancelled" }),
    ).rejects.toThrow(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("updates an approval after project write access succeeds", async () => {
    returning.mockResolvedValue([approvalRow(999, "escalated")]);

    await expect(
      service.updateApproval(user, PROJECT_ID, APPROVAL_ID, { status: "escalated" }),
    ).resolves.toMatchObject({ id: APPROVAL_ID, status: "escalated" });
    expect(assertProjectWriteAccess).toHaveBeenCalledWith(db, access, user, PROJECT_ID);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("denies approval deletion before loading or writing when project write access fails", async () => {
    jest.mocked(assertProjectWriteAccess).mockRejectedValue(new ForbiddenException());

    await expect(service.softDeleteApproval(user, PROJECT_ID, APPROVAL_ID)).rejects.toThrow(
      ForbiddenException,
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("deletes an approval after project write access succeeds and preserves audit logging", async () => {
    await expect(
      service.softDeleteApproval(user, PROJECT_ID, APPROVAL_ID),
    ).resolves.toBeUndefined();
    expect(assertProjectWriteAccess).toHaveBeenCalledWith(db, access, user, PROJECT_ID);
    expect(update).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "approval.deleted",
        userId: user.userId,
        orgId: user.orgId,
        resourceId: String(APPROVAL_ID),
      }),
    );
  });
});
