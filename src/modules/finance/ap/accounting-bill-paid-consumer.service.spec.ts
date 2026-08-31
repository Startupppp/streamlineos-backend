import { AccountingBillPaidConsumerService } from "./accounting-bill-paid-consumer.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-bill-paid-1";
const EVENT_ID = "evt-bill-paid-aaa";
const BILL_ID = 77;
const BILL_NUMBER = "BILL-0077";
const ACTOR_USER_ID = "user-actor";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "purchase_bill",
    aggregateId: String(BILL_ID),
    aggregateVersion: 1,
    eventType: "accounting.bill.paid",
    payload: {
      organization_id: ORG_ID,
      bill_id: BILL_ID,
      bill_number: BILL_NUMBER,
      payment_id: 11,
      amount_cents: 500000,
      run_id: 3,
      actor_user_id: ACTOR_USER_ID,
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

function buildDbMock(options: { claimed?: boolean }): {
  insert: jest.Mock;
  update: jest.Mock;
} {
  const { claimed = true } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  return { insert: dbInsert, update: dbUpdate };
}

async function buildService(options: {
  claimed?: boolean;
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
      AccountingBillPaidConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(AccountingBillPaidConsumerService);
  return { svc, db, dispatch, registry };
}

describe("AccountingBillPaidConsumerService", () => {
  describe("onModuleInit", () => {
    it("registers itself with the OutboxConsumerRegistry", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = accounting.bill.paid", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("accounting.bill.paid");
    });
  });

  describe("claim fence — exactly-once processing", () => {
    it("skips processing when the inbox record was already claimed", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("replay is a no-op: a second call with the same event does not dispatch", async () => {
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

    it("does not call db.update when the claim fence fires", async () => {
      const { svc, db } = await buildService({ claimed: false });
      await svc.handle(makeEvent());
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED when payload bill_id is not a number", async () => {
      const { svc, db } = await buildService({});
      const bad = makeEvent();
      (bad.payload as Record<string, unknown>)["bill_id"] = "not-a-number";

      await svc.handle(bad);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });

    it("does not dispatch when payload is invalid", async () => {
      const { svc, dispatch } = await buildService({});
      const bad = makeEvent();
      (bad.payload as Record<string, unknown>)["amount_cents"] = "not-a-number";

      await svc.handle(bad);

      expect(dispatch.emit).not.toHaveBeenCalled();
    });
  });

  describe("happy path", () => {
    it("dispatches accounting.payment.recorded to the bill actor", async () => {
      const { svc, dispatch } = await buildService({});

      await svc.handle(makeEvent());

      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "accounting.payment.recorded",
          orgId: ORG_ID,
          targetUserIds: [ACTOR_USER_ID],
          actorUserId: ACTOR_USER_ID,
          entityType: "purchase_bill",
          entityId: String(BILL_ID),
        }),
      );
    });

    it("includes bill number and amount in variables", async () => {
      const { svc, dispatch } = await buildService({});

      await svc.handle(makeEvent());

      const callArg = (dispatch.emit as jest.Mock).mock.calls[0]?.[0] as
        | { variables: { billNumber: string; amount: number } }
        | undefined;
      expect(callArg?.variables).toMatchObject({
        billNumber: BILL_NUMBER,
        amount: 5000,
      });
    });

    it("marks inbox COMPLETED on success", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETED" }));
    });

    it("uses a stable idempotency key derived from org, consumer name and event id", async () => {
      const { svc, dispatch } = await buildService({});

      await svc.handle(makeEvent());

      const callArg = (dispatch.emit as jest.Mock).mock.calls[0]?.[0] as
        | { dedupeKey: string }
        | undefined;
      expect(callArg?.dedupeKey).toContain(ORG_ID);
      expect(callArg?.dedupeKey).toContain(EVENT_ID);
    });
  });

  describe("error propagation — dead-letter path", () => {
    it("propagates a thrown error so the relay marks the outbox event RETRY (or DEAD at max retries)", async () => {
      const { svc } = await buildService({
        emitImpl: async () => {
          throw new Error("downstream failure");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("downstream failure");
    });

    it("does not mark inbox COMPLETED when dispatch throws", async () => {
      const { svc, db } = await buildService({
        emitImpl: async () => {
          throw new Error("transport error");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow();

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      const statusArg = setCall?.set.mock.calls[0]?.[0] as { status?: string } | undefined;
      expect(statusArg?.status).not.toBe("COMPLETED");
    });
  });
});
