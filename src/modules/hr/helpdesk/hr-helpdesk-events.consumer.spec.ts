import { Test, type TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { HrHelpdeskEventsConsumer } from "./hr-helpdesk-events.consumer";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";

const makeEvent = (overrides: Partial<OutboxEventRow> = {}): OutboxEventRow => ({
  outboxEventId: 1,
  eventId: "evt-001",
  organizationId: "org1",
  aggregateType: "helpdesk_ticket",
  aggregateId: "1",
  aggregateVersion: 1,
  eventType: "hr.helpdesk.ticket_created",
  schemaVersion: 1,
  payload: {
    ticketId: 1,
    orgId: "org1",
    creatorId: "user1",
    title: "Help with payroll",
    category: "payroll_issue",
    queue: "FINANCE",
    priority: "MEDIUM",
    isConfidential: false,
  },
  occurredAt: new Date(),
  createdAt: new Date(),
  audience: "INTERNAL",
  actorMembershipId: null,
  causationId: null,
  correlationId: null,
  lifecycleState: "ACTIVE",
  deliveryState: "PENDING",
  publishedAt: null,
  leaseExpiresAt: null,
  retryCount: 0,
  lastError: null,
  deadLetteredAt: null,
  ...overrides,
});

const mockClaim = jest.fn().mockResolvedValue(true);
const mockMarkProcessed = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../common/outbox/inbox-consumer", () => ({
  InboxConsumer: jest.fn().mockImplementation(() => ({
    claim: mockClaim,
    markProcessed: mockMarkProcessed,
  })),
}));

const mockDispatch = { emit: jest.fn().mockResolvedValue(undefined) };
const mockAccess = { membersWithPermission: jest.fn().mockResolvedValue([{ userId: "hr-mgr" }]) };
const mockRegistry = { register: jest.fn() };

const mockInsertFn = jest.fn().mockReturnThis();
const mockValuesFn = jest.fn().mockReturnThis();
const mockOnConflictFn = jest.fn().mockReturnThis();
const mockReturningFn = jest.fn().mockResolvedValue([]);

const mockDb = {
  insert: mockInsertFn,
  values: mockValuesFn,
  onConflictDoNothing: mockOnConflictFn,
  returning: mockReturningFn,
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  execute: jest.fn().mockResolvedValue([]),
};

describe("HrHelpdeskEventsConsumer", () => {
  let consumer: HrHelpdeskEventsConsumer;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClaim.mockResolvedValue(true);
    mockMarkProcessed.mockResolvedValue(undefined);
    mockDispatch.emit.mockResolvedValue(undefined);
    mockAccess.membersWithPermission.mockResolvedValue([{ userId: "hr-mgr" }]);

    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrHelpdeskEventsConsumer,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: NotificationDispatchService, useValue: mockDispatch },
        { provide: OutboxConsumerRegistry, useValue: mockRegistry },
        { provide: AccessService, useValue: mockAccess },
      ],
    }).compile();

    consumer = module.get(HrHelpdeskEventsConsumer);
  });

  it("registers all three event types on module init", () => {
    consumer.onModuleInit();
    expect(mockRegistry.register).toHaveBeenCalledTimes(3);
    const registered = mockRegistry.register.mock.calls.map((c: [{ eventType: string }]) => c[0].eventType);
    expect(registered).toContain("hr.helpdesk.ticket_created");
    expect(registered).toContain("hr.helpdesk.ticket_assigned");
    expect(registered).toContain("hr.helpdesk.ticket_status_changed");
  });

  describe("duplicate delivery", () => {
    it("skips processing when the inbox claim returns false (duplicate)", async () => {
      mockClaim.mockResolvedValue(false);

      await consumer.handle(makeEvent());

      expect(mockDispatch.emit).not.toHaveBeenCalled();
      expect(mockMarkProcessed).not.toHaveBeenCalled();
    });

    it("processes the event on first delivery", async () => {
      mockClaim.mockResolvedValue(true);

      await consumer.handle(makeEvent());

      expect(mockDispatch.emit).toHaveBeenCalledTimes(1);
      expect(mockMarkProcessed).toHaveBeenCalledWith(expect.any(String), "evt-001", "COMPLETED", null);
    });
  });

  describe("invalid payload", () => {
    it("marks the event FAILED and rethrows when payload is invalid", async () => {
      const event = makeEvent({ payload: { garbage: true } });

      await expect(consumer.handle(event)).rejects.toThrow();

      expect(mockMarkProcessed).toHaveBeenCalledWith(
        expect.any(String),
        "evt-001",
        "FAILED",
        expect.stringContaining("Invalid payload"),
      );
      expect(mockDispatch.emit).not.toHaveBeenCalled();
    });
  });

  describe("dispatch failure", () => {
    it("marks the event FAILED and rethrows when dispatch throws", async () => {
      mockDispatch.emit.mockRejectedValueOnce(new Error("notification service down"));

      await expect(consumer.handle(makeEvent())).rejects.toThrow("notification service down");

      expect(mockMarkProcessed).toHaveBeenCalledWith(
        expect.any(String),
        "evt-001",
        "FAILED",
        "notification service down",
      );
    });
  });

  describe("ticket_created event", () => {
    it("notifies the routed queue's members and the support administrators, never HR at large", async () => {
      mockAccess.membersWithPermission.mockImplementation(async (_orgId: string, key: string) =>
        key === "hr:helpdesk:queue-finance"
          ? [{ userId: "finance-agent" }]
          : key === "hr:helpdesk:manage"
            ? [{ userId: "support-admin" }, { userId: "finance-agent" }]
            : [{ userId: "hr-mgr" }],
      );

      await consumer.handle(makeEvent());

      expect(mockAccess.membersWithPermission).toHaveBeenCalledWith("org1", "hr:helpdesk:queue-finance");
      expect(mockAccess.membersWithPermission).toHaveBeenCalledWith("org1", "hr:helpdesk:manage");
      expect(mockAccess.membersWithPermission).not.toHaveBeenCalledWith("org1", "hr:employees:manage");
      expect(mockDispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "hr.helpdesk.ticket_created",
          targetUserIds: ["finance-agent", "support-admin"],
          link: "/hr/helpdesk?queue=FINANCE&ticket=1",
        }),
      );
    });

    it("rejects a created payload that names no queue, so an unrouted ticket can never notify nobody silently", async () => {
      const event = makeEvent({
        payload: {
          ticketId: 1,
          orgId: "org1",
          creatorId: "user1",
          title: "Help with payroll",
          category: "payroll_issue",
          priority: "MEDIUM",
        },
      });

      await expect(consumer.handle(event)).rejects.toThrow("Invalid payload");
    });
  });

  describe("ticket_assigned event", () => {
    it("emits with the correct target user (the assignee)", async () => {
      const event = makeEvent({
        eventType: "hr.helpdesk.ticket_assigned",
        payload: {
          ticketId: 1,
          orgId: "org1",
          actorId: "admin1",
          assigneeId: "agent1",
          title: "Help with payroll",
        },
      });

      await consumer.handle(event);

      expect(mockDispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "hr.helpdesk.ticket_assigned",
          targetUserIds: ["agent1"],
        }),
      );
    });
  });

  describe("ticket_status_changed event", () => {
    it("emits with the correct target user (the ticket owner)", async () => {
      const event = makeEvent({
        eventType: "hr.helpdesk.ticket_status_changed",
        payload: {
          ticketId: 1,
          orgId: "org1",
          actorId: "admin1",
          newStatus: "DONE",
          title: "Help with payroll",
          ownerId: "owner1",
        },
      });

      await consumer.handle(event);

      expect(mockDispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "hr.helpdesk.ticket_status_changed",
          targetUserIds: ["owner1"],
        }),
      );
    });
  });
});
