import { BuildSprintCompletedConsumerService } from "./build-sprint-completed-consumer.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-sprint-1";
const EVENT_ID = "evt-sprint-aaa";
const SPRINT_ID = 10;
const PROJECT_ID = 5;
const SPRINT_NAME = "Sprint Q1";
const ASSIGNEE_A = "user-a";
const ASSIGNEE_B = "user-b";

function makeEvent(overrides: Partial<OutboxEventRow["payload"]> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "sprint",
    aggregateId: String(SPRINT_ID),
    aggregateVersion: 1,
    eventType: "build.sprint.completed",
    payload: {
      sprintId: SPRINT_ID,
      projectId: PROJECT_ID,
      orgId: ORG_ID,
      name: SPRINT_NAME,
      actorUserId: null,
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
  assignees?: Array<{ assigneeId: string | null }>;
}): {
  insert: jest.Mock;
  update: jest.Mock;
  selectDistinct: jest.Mock;
} {
  const { claimed = true, assignees = [{ assigneeId: ASSIGNEE_A }, { assigneeId: ASSIGNEE_B }] } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const dbSelectDistinct = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(assignees),
    }),
  });

  return { insert: dbInsert, update: dbUpdate, selectDistinct: dbSelectDistinct };
}

async function buildService(options: {
  claimed?: boolean;
  assignees?: Array<{ assigneeId: string | null }>;
  emitDurableImpl?: () => Promise<void>;
}) {
  const { emitDurableImpl = async () => undefined } = options;
  const db = buildDbMock(options);
  const dispatch = {
    emitDurable: jest.fn().mockImplementation(emitDurableImpl),
  } as unknown as NotificationDispatchService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      BuildSprintCompletedConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(BuildSprintCompletedConsumerService);
  return { svc, db, dispatch, registry };
}

describe("BuildSprintCompletedConsumerService", () => {
  describe("onModuleInit", () => {
    it("registers itself with the OutboxConsumerRegistry", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = build.sprint.completed", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("build.sprint.completed");
    });
  });

  describe("claim fence — exactly-once processing", () => {
    it("skips processing when the inbox record was already claimed", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(dispatch.emitDurable).not.toHaveBeenCalled();
    });

    it("is idempotent: a second call with the same event does not dispatch", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      await svc.handle(makeEvent());
      expect(dispatch.emitDurable).not.toHaveBeenCalled();
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
      const badEvent = makeEvent();
      (badEvent.payload as Record<string, unknown>)["sprintId"] = "not-a-number";

      await svc.handle(badEvent);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });
  });

  describe("zero recipients", () => {
    it("marks inbox SKIPPED when the sprint has no ticket assignees", async () => {
      const { svc, dispatch, db } = await buildService({ assignees: [] });
      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });

    it("marks inbox SKIPPED when all ticket assignees are null", async () => {
      const { svc, dispatch, db } = await buildService({
        assignees: [{ assigneeId: null }],
      });
      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });
  });

  describe("happy path", () => {
    it("dispatches build.sprint.completed to all ticket assignees regardless of ticket status", async () => {
      const { svc, dispatch } = await buildService({
        assignees: [{ assigneeId: ASSIGNEE_A }, { assigneeId: ASSIGNEE_B }],
      });

      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventKey: "build.sprint.completed",
          orgId: ORG_ID,
          targetUserIds: expect.arrayContaining([ASSIGNEE_A, ASSIGNEE_B]),
          entityType: "sprint",
          entityId: String(SPRINT_ID),
        }),
      );
    });

    it("marks inbox COMPLETED on success", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETED" }));
    });
  });

  describe("error propagation", () => {
    it("propagates a thrown error so the relay marks the outbox event RETRY", async () => {
      const { svc } = await buildService({
        emitDurableImpl: async () => {
          throw new Error("downstream failure");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("downstream failure");
    });
  });
});
