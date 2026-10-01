import type { Db } from "../../../../db/drizzle.types";
import type { OutboxConsumerRegistry, OutboxEventRow } from "../../../../common/outbox/outbox-consumer.registry";
import type { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { BuildBlockerCreatedConsumerService } from "../tickets/build-blocker-created-consumer.service";
import { BuildTicketStatusChangedConsumerService } from "../tickets/build-ticket-status-changed-consumer.service";
import { BuildApprovalRequestedConsumerService } from "../../approvals/build-approval-requested-consumer.service";

const mockClaim = jest.fn();
const mockMarkProcessed = jest.fn();

jest.mock("../../../../common/outbox/inbox-consumer", () => ({
  InboxConsumer: jest.fn().mockImplementation(() => ({ claim: mockClaim, markProcessed: mockMarkProcessed })),
}));

const EVENT_ORG = "org-event";
const FOREIGN_ORG = "org-foreign";

function event(eventType: string, payload: Record<string, unknown>): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "evt-1",
    organizationId: EVENT_ORG,
    aggregateType: "ticket",
    aggregateId: "1",
    aggregateVersion: 1,
    eventType,
    payload,
    deliveryState: "IN_FLIGHT",
    retryCount: 0,
    schemaVersion: 1,
    audience: "INTERNAL",
    actorMembershipId: null,
    causationId: null,
    correlationId: null,
    occurredAt: new Date(),
    publishedAt: null,
    leaseExpiresAt: null,
    lastError: null,
    deadLetteredAt: null,
    lifecycleState: "ACTIVE",
    createdAt: new Date(),
  };
}

function harness() {
  const where = jest.fn().mockResolvedValue([{ userId: "assignee-1", membershipId: 3 }]);
  const db = { select: () => ({ from: () => ({ innerJoin: () => ({ where }) }) }) } as unknown as Db;
  const emit = jest.fn().mockResolvedValue(undefined);
  const dispatch = { emit } as unknown as NotificationDispatchService;
  const registry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;
  return { db, dispatch, registry, emit, where };
}

const blockerPayload = (orgId: string) => ({
  relationId: 1, blockedTicketId: 10, blockingTicketId: 11, projectId: 2, orgId, actorUserId: "actor-1",
});
const statusPayload = (orgId: string) => ({
  ticketId: 10, projectId: 2, orgId, previousStatus: "TODO", newStatus: "DONE", actorUserId: "actor-1",
});
const approvalPayload = (orgId: string) => ({
  approvalId: 4, projectId: 2, orgId, approverUserId: "approver-1", requestedByUserId: "actor-1", title: "Ship it",
});

const cases = [
  {
    name: "build.blocker.created",
    run: (h: ReturnType<typeof harness>, orgId: string) =>
      new BuildBlockerCreatedConsumerService(h.db, h.dispatch, h.registry).handle(event("build.blocker.created", blockerPayload(orgId))),
  },
  {
    name: "build.ticket.status_changed",
    run: (h: ReturnType<typeof harness>, orgId: string) =>
      new BuildTicketStatusChangedConsumerService(h.db, h.dispatch, h.registry).handle(event("build.ticket.status_changed", statusPayload(orgId))),
  },
  {
    name: "build.approval.requested",
    run: (h: ReturnType<typeof harness>, orgId: string) =>
      new BuildApprovalRequestedConsumerService(h.db, h.dispatch, h.registry).handle(event("build.approval.requested", approvalPayload(orgId))),
  },
];

beforeEach(() => {
  mockClaim.mockReset().mockResolvedValue(true);
  mockMarkProcessed.mockReset().mockResolvedValue(undefined);
});

describe.each(cases)("$name consumer takes its tenant from the outbox row, never from the payload", ({ run }) => {
  it("refuses an event whose payload names a different organisation, dispatching nothing", async () => {
    const h = harness();
    await run(h, FOREIGN_ORG);
    expect(h.emit).not.toHaveBeenCalled();
    expect(mockMarkProcessed).toHaveBeenCalledWith(expect.any(String), "evt-1", "FAILED", expect.stringContaining("tenant"));
  });

  it("dispatches under event.organizationId when the payload agrees", async () => {
    const h = harness();
    await run(h, EVENT_ORG);
    expect(h.emit).toHaveBeenCalledWith(expect.objectContaining({ orgId: EVENT_ORG }));
    expect(mockMarkProcessed).toHaveBeenCalledWith(expect.any(String), "evt-1", "COMPLETED", null);
  });
});
