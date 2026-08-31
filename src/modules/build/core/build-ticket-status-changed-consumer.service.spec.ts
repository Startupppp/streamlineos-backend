import { BuildTicketStatusChangedConsumerService } from "./build-ticket-status-changed-consumer.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-ticket-status-1";
const EVENT_ID = "evt-ticket-status-aaa";
const TICKET_ID = 42;
const PROJECT_ID = 5;
const ACTOR_USER_ID = "actor-user-1";
const ASSIGNEE_A = "assignee-user-a";
const ASSIGNEE_B = "assignee-user-b";

function makeEvent(
  overrides: Partial<Record<string, unknown>> = {},
): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "ticket",
    aggregateId: String(TICKET_ID),
    aggregateVersion: 1,
    eventType: "build.ticket.status_changed",
    payload: {
      ticketId: TICKET_ID,
      projectId: PROJECT_ID,
      orgId: ORG_ID,
      previousStatus: "TODO",
      newStatus: "IN_PROGRESS",
      actorUserId: ACTOR_USER_ID,
      ...overrides,
    },
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

function buildDbMock(options: {
  claimed?: boolean;
  assignees?: Array<{ userId: string }>;
}): {
  insert: jest.Mock;
  update: jest.Mock;
  select: jest.Mock;
} {
  const { claimed = true, assignees = [{ userId: ASSIGNEE_A }, { userId: ASSIGNEE_B }] } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const dbSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(assignees),
    }),
  });

  return { insert: dbInsert, update: dbUpdate, select: dbSelect };
}

async function buildService(options: {
  claimed?: boolean;
  assignees?: Array<{ userId: string }>;
  emitImpl?: () => Promise<void>;
}) {
  const { emitImpl = async () => undefined } = options;
  const db = buildDbMock(options);
  const dispatch = {
    emit: jest.fn().mockImplementation(emitImpl),
  } as unknown as NotificationDispatchService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      BuildTicketStatusChangedConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(BuildTicketStatusChangedConsumerService);
  return { svc, db, dispatch, registry };
}

describe("BuildTicketStatusChangedConsumerService", () => {
  describe("onModuleInit", () => {
    it("registers itself with the OutboxConsumerRegistry", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = build.ticket.status_changed", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("build.ticket.status_changed");
    });
  });

  describe("claim fence — exactly-once processing", () => {
    it("skips processing when the inbox record was already claimed", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("is idempotent: a second call with the same event does not dispatch", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      await svc.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("calls db.insert to attempt the inbox claim on every handle() invocation", async () => {
      const { svc, db } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED when the payload does not match the schema", async () => {
      const { svc, db } = await buildService({});
      const badEvent = makeEvent({ ticketId: "not-a-number" });

      await svc.handle(badEvent);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });
  });

  describe("zero recipients — actor excluded", () => {
    it("marks inbox SKIPPED when the only assignee is the actor", async () => {
      const { svc, dispatch, db } = await buildService({ assignees: [] });
      await svc.handle(makeEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("happy path", () => {
    it("dispatches build.ticket.status_changed to assignees excluding the actor", async () => {
      const { svc, dispatch } = await buildService({
        assignees: [{ userId: ASSIGNEE_A }, { userId: ASSIGNEE_B }],
      });

      await svc.handle(makeEvent());

      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "build.ticket.status_changed",
          orgId: ORG_ID,
          targetUserIds: expect.arrayContaining([ASSIGNEE_A, ASSIGNEE_B]),
          entityType: "ticket",
          entityId: String(TICKET_ID),
        }),
      );
    });

    it("marks inbox COMPLETED on success", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });
  });

  describe("error propagation", () => {
    it("propagates a thrown error so the relay marks the outbox event RETRY", async () => {
      const { svc } = await buildService({
        emitImpl: async () => {
          throw new Error("downstream failure");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("downstream failure");
    });
  });

  describe("tenant isolation — cross-tenant DENY", () => {
    it("emits only to recipients within the event organizationId", async () => {
      const { svc, dispatch } = await buildService({
        assignees: [{ userId: ASSIGNEE_A }],
      });

      await svc.handle(makeEvent());

      const emitCall = (dispatch.emit as jest.Mock).mock
        .calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(emitCall?.orgId).toBe(ORG_ID);
      expect(emitCall?.targetUserIds).toContain(ASSIGNEE_A);
      expect(emitCall?.targetUserIds).not.toContain(ACTOR_USER_ID);
    });
  });
});
