import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  ExpenseDecidedConsumer,
  ExpenseExportRequestedConsumer,
} from "./expense-outbox.consumer";
import { ExpenseExportWorkerService } from "./expense-export-worker.service";
import {
  EXPENSE_DECIDED_EVENT,
  EXPENSE_EXPORT_REQUESTED_EVENT,
} from "./dto/expense-outbox.schemas";

const ORG_ID = "org-expense-2";
const OTHER_ORG = "org-expense-other";
const EVENT_ID = "evt-expense-bbb";
const ACTOR_USER_ID = "user-manager";
const RECIPIENT_USER_ID = "user-submitter";
const EXPENSE_ID = 77;

function makeDecidedEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "expense",
    aggregateId: String(EXPENSE_ID),
    aggregateVersion: 1,
    eventType: EXPENSE_DECIDED_EVENT,
    payload: {
      expenseId: EXPENSE_ID,
      orgId: ORG_ID,
      actorUserId: ACTOR_USER_ID,
      recipientUserId: RECIPIENT_USER_ID,
      status: "APPROVED",
      amount: "250.00",
      category: "TRAVEL",
      rejectionReason: null,
      journalEntryId: null,
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
    ...overrides,
  };
}

function makeExportEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 2,
    eventId: "evt-expense-export-ccc",
    organizationId: ORG_ID,
    aggregateType: "expense",
    aggregateId: "export-job-1",
    aggregateVersion: 1,
    eventType: EXPENSE_EXPORT_REQUESTED_EVENT,
    payload: { jobId: 1 },
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
    ...overrides,
  };
}

function buildDecidedDbMock(options: { claimed?: boolean } = {}) {
  const { claimed = true } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const dbExecute = jest.fn().mockResolvedValue([]);

  return { insert: dbInsert, update: dbUpdate, execute: dbExecute };
}

async function buildDecidedConsumer(options: {
  claimed?: boolean;
  emitImpl?: () => Promise<void>;
}) {
  const { emitImpl = async () => undefined } = options;
  const db = buildDecidedDbMock(options);
  const dispatch = {
    emit: jest.fn().mockImplementation(emitImpl),
  } as unknown as NotificationDispatchService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      ExpenseDecidedConsumer,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(ExpenseDecidedConsumer);
  return { svc, db, dispatch, registry };
}

async function buildExportConsumer(options: { wakeImpl?: () => void } = {}) {
  const { wakeImpl = () => undefined } = options;
  const worker = {
    wake: jest.fn().mockImplementation(wakeImpl),
  } as unknown as ExpenseExportWorkerService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      ExpenseExportRequestedConsumer,
      { provide: ExpenseExportWorkerService, useValue: worker },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(ExpenseExportRequestedConsumer);
  return { svc, worker, registry };
}

describe("ExpenseDecidedConsumer — supplemental B2/B3/B4/B5", () => {
  describe("registration", () => {
    it("declares eventType = expense.decided", async () => {
      const { svc } = await buildDecidedConsumer({});
      expect(svc.eventType).toBe(EXPENSE_DECIDED_EVENT);
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("routes the notification using only event.organizationId — safe without ambient context", async () => {
      const { svc, dispatch } = await buildDecidedConsumer({});
      const isolatedOrg = "org-isolated-decided";
      const event = makeDecidedEvent({
        organizationId: isolatedOrg,
        payload: {
          expenseId: EXPENSE_ID,
          orgId: isolatedOrg,
          actorUserId: ACTOR_USER_ID,
          recipientUserId: RECIPIENT_USER_ID,
          status: "APPROVED",
          amount: "250.00",
          category: "TRAVEL",
          rejectionReason: null,
          journalEntryId: null,
        },
      });

      await svc.handle(event);

      const emitted = (dispatch.emit as jest.Mock).mock.calls[0]?.[0] as { orgId: string } | undefined;
      expect(emitted?.orgId).toBe(isolatedOrg);
    });

    it("refuses an event whose payload orgId does not match event.organizationId", async () => {
      const { svc, dispatch, db } = await buildDecidedConsumer({});
      const event = makeDecidedEvent({
        organizationId: ORG_ID,
        payload: {
          expenseId: EXPENSE_ID,
          orgId: OTHER_ORG,
          actorUserId: ACTOR_USER_ID,
          recipientUserId: RECIPIENT_USER_ID,
          status: "APPROVED",
          amount: "250.00",
          category: "TRAVEL",
          rejectionReason: null,
          journalEntryId: null,
        },
      });

      await svc.handle(event);

      expect(dispatch.emit).not.toHaveBeenCalled();
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("B3 — transient dispatch failure marks FAILED and rethrows", () => {
    it("marks inbox FAILED and propagates when dispatch.emit throws", async () => {
      const { svc, db } = await buildDecidedConsumer({
        emitImpl: async () => { throw new Error("notification provider down"); },
      });

      await expect(svc.handle(makeDecidedEvent())).rejects.toThrow("notification provider down");

      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });

    it("records the dispatch error in inbox lastError", async () => {
      const { svc, db } = await buildDecidedConsumer({
        emitImpl: async () => { throw new Error("decided-dispatch-error"); },
      });

      await expect(svc.handle(makeDecidedEvent())).rejects.toThrow("decided-dispatch-error");

      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: "decided-dispatch-error" }),
      );
    });
  });

  describe("B4 — duplicate suppression via inbox fence", () => {
    it("does not dispatch when the inbox claim is already taken", async () => {
      const { svc, dispatch } = await buildDecidedConsumer({ claimed: false });

      await svc.handle(makeDecidedEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("delivering the same decided event twice dispatches exactly once", async () => {
      const { svc, dispatch } = await buildDecidedConsumer({ claimed: false });

      await svc.handle(makeDecidedEvent());
      await svc.handle(makeDecidedEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
    });
  });

  describe("B5 — DLQ replay: stable idempotency key on retry", () => {
    it("reuses the same dedupeKey on first and second dispatch call", async () => {
      const emitFn = jest.fn()
        .mockRejectedValueOnce(new Error("transient failure"))
        .mockResolvedValueOnce(undefined);
      const { svc } = await buildDecidedConsumer({ emitImpl: emitFn });

      await expect(svc.handle(makeDecidedEvent())).rejects.toThrow("transient failure");
      await svc.handle(makeDecidedEvent());

      expect(emitFn).toHaveBeenCalledTimes(2);
      const key0 = (emitFn.mock.calls[0]?.[0] as { dedupeKey: string } | undefined)?.dedupeKey;
      const key1 = (emitFn.mock.calls[1]?.[0] as { dedupeKey: string } | undefined)?.dedupeKey;
      expect(key0).toBe(key1);
      expect(key0).toContain(ORG_ID);
      expect(key0).toContain(EVENT_ID);
    });
  });
});

describe("ExpenseExportRequestedConsumer", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", async () => {
      const { svc, registry } = await buildExportConsumer();
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = expense.export.requested", async () => {
      const { svc } = await buildExportConsumer();
      expect(svc.eventType).toBe(EXPENSE_EXPORT_REQUESTED_EVENT);
    });
  });

  describe("B1 — consumer correctness", () => {
    it("calls worker.wake() on every delivered event", async () => {
      const { svc, worker } = await buildExportConsumer();

      await svc.handle(makeExportEvent());

      expect(worker.wake).toHaveBeenCalledTimes(1);
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("worker.wake() is org-agnostic — no org-specific context required", async () => {
      const { svc, worker } = await buildExportConsumer();

      await svc.handle(makeExportEvent({ organizationId: "org-isolated-export" }));

      expect(worker.wake).toHaveBeenCalledTimes(1);
    });
  });

  describe("B3 — thin consumer: wake() is synchronous, no retry surface", () => {
    it("resolves without throwing for any event payload", async () => {
      const { svc } = await buildExportConsumer();

      await expect(svc.handle(makeExportEvent({ payload: null }))).resolves.toBeUndefined();
    });
  });

  describe("B4 — no inbox fence: wake() called per delivery (at-least-once)", () => {
    it("calls worker.wake() twice when the same event is delivered twice", async () => {
      const { svc, worker } = await buildExportConsumer();

      await svc.handle(makeExportEvent());
      await svc.handle(makeExportEvent());

      expect(worker.wake).toHaveBeenCalledTimes(2);
    });
  });

  describe("B5 — DLQ replay: wake() is idempotent — re-delivery is safe", () => {
    it("wakes the worker on both the first call and the relay retry", async () => {
      const { svc, worker } = await buildExportConsumer();

      await svc.handle(makeExportEvent());
      await svc.handle(makeExportEvent());

      expect(worker.wake).toHaveBeenCalledTimes(2);
    });
  });
});
