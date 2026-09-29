process.env.APP_URL ??= "http://localhost:1000";

import { ApprovalsService } from "./approvals.service";
import { BuildApprovalRequestedConsumerService } from "./build-approval-requested-consumer.service";
import { buildApprovalRequestedPayloadSchema } from "./dto/build-approval-requested-payload.schema";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";
import type { Db } from "../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

jest.mock("../core", () => ({
  assertProjectAccess: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../common/organization/organization-actor", () => ({
  assertOrganizationActor: jest.fn().mockResolvedValue({ membershipId: 42, kind: "user" }),
  OrganizationActorError: class extends Error {},
  organizationActorHttpError: jest.fn(),
}));

const ORG = "org-approval-emit";
const PROJECT_ID = 7;
const APPROVAL_ID = 55;

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "requester-1",
  isOrgOwner: true,
  principal: humanSessionPrincipal(1, true),
} as never;

function makeDb() {
  const tx = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest
          .fn()
          .mockResolvedValue([{ id: APPROVAL_ID, title: "Ship the release" }]),
      }),
    }),
  };
  return {
    query: { projectApprovals: { findFirst: jest.fn().mockResolvedValue(undefined) } },
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as Db;
}

describe("creating an approval emits build.approval.requested so the approver is told, not only the project channel", () => {
  it("emits one event naming the approver, inside the transaction that inserted the approval", async () => {
    const emit = jest.spyOn(OutboxWriter, "emit").mockResolvedValue(undefined);
    const service = new ApprovalsService(
      makeDb(),
      { log: jest.fn() } as never,
      { holds: jest.fn().mockResolvedValue(true) } as never,
      { getOrCreateEntityChannel: jest.fn() } as never,
      { sendSystemMessage: jest.fn() } as never,
    );

    await service.createApproval(actor, PROJECT_ID, {
      entityType: "ticket",
      entityId: 3,
      title: "Ship the release",
      approverId: "approver-9",
    } as never);

    expect(emit).toHaveBeenCalledTimes(1);
    const input = emit.mock.calls[0]?.[1];
    expect(input?.eventType).toBe("build.approval.requested");
    const payload = buildApprovalRequestedPayloadSchema.parse(input?.payload);
    expect(payload.approverUserId).toBe("approver-9");
    expect(payload.requestedByUserId).toBe("requester-1");
    expect(payload.approvalId).toBe(APPROVAL_ID);
    emit.mockRestore();
  });
});

describe("the build.approval.requested consumer notifies the approver", () => {
  function makeConsumerDb() {
    return {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([{ id: 1 }]),
          }),
        }),
      }),
    } as unknown as Db;
  }

  const event = {
    eventId: "22222222-2222-4222-8222-222222222222",
    organizationId: ORG,
    aggregateType: "project_approval",
    aggregateId: String(APPROVAL_ID),
    aggregateVersion: 1,
    eventType: "build.approval.requested",
    payload: {
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      orgId: ORG,
      approverUserId: "approver-9",
      requestedByUserId: "requester-1",
      title: "Ship the release",
    },
  } as never;

  it("dispatches to the approver alone, not the requester", async () => {
    const emit = jest.fn().mockResolvedValue(undefined);
    const service = new BuildApprovalRequestedConsumerService(
      makeConsumerDb(),
      { emit } as never,
      { register: jest.fn() } as never,
    );
    await service.handle(event);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: "build.approval.requested",
        entityId: String(APPROVAL_ID),
        targetUserIds: ["approver-9"],
      }),
    );
  });

  it("dispatches nothing for a payload missing the approver", async () => {
    const emit = jest.fn().mockResolvedValue(undefined);
    const service = new BuildApprovalRequestedConsumerService(
      makeConsumerDb(),
      { emit } as never,
      { register: jest.fn() } as never,
    );
    await service.handle({ ...(event as object), payload: { approvalId: APPROVAL_ID } } as never);
    expect(emit).not.toHaveBeenCalled();
  });

  it("declares the event type the producer emits", () => {
    const service = new BuildApprovalRequestedConsumerService(
      makeConsumerDb(),
      { emit: jest.fn() } as never,
      { register: jest.fn() } as never,
    );
    expect(service.eventType).toBe("build.approval.requested");
  });
});
