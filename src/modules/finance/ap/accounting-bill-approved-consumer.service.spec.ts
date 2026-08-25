import { AccountingBillApprovedConsumerService } from "./accounting-bill-approved-consumer.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-ap-1";
const EVENT_ID = "evt-bill-aaa";
const BILL_ID = 42;
const BILL_NUMBER = "BILL-0042";
const APPROVER_USER_ID = "user-approver";
const SUBMITTER_USER_ID = "user-submitter";

function makeEvent(overrides: Partial<OutboxEventRow["payload"]> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "purchase_bill",
    aggregateId: String(BILL_ID),
    aggregateVersion: 1,
    eventType: "accounting.bill.approved",
    payload: {
      organization_id: ORG_ID,
      bill_id: BILL_ID,
      bill_number: BILL_NUMBER,
      total_cents: 100000,
      actor_user_id: APPROVER_USER_ID,
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
  approvalReq?: { requestedBy: string } | null;
}): {
  insert: jest.Mock;
  update: jest.Mock;
  select: jest.Mock;
} {
  const {
    claimed = true,
    approvalReq = { requestedBy: SUBMITTER_USER_ID },
  } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const approvalRows = approvalReq !== null ? [approvalReq] : [];
  const dbSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(approvalRows),
      }),
    }),
  });

  return { insert: dbInsert, update: dbUpdate, select: dbSelect };
}

async function buildService(options: {
  claimed?: boolean;
  approvalReq?: { requestedBy: string } | null;
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
      AccountingBillApprovedConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(AccountingBillApprovedConsumerService);
  return { svc, db, dispatch, registry };
}

describe("AccountingBillApprovedConsumerService", () => {
  describe("onModuleInit", () => {
    it("registers itself with the OutboxConsumerRegistry", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = accounting.bill.approved", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("accounting.bill.approved");
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
      (badEvent.payload as Record<string, unknown>)["bill_id"] = "not-a-number";

      await svc.handle(badEvent);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });
  });

  describe("zero recipients", () => {
    it("marks inbox SKIPPED when no approval request exists for the bill", async () => {
      const { svc, dispatch, db } = await buildService({ approvalReq: null });
      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });
  });

  describe("happy path", () => {
    it("dispatches accounting.bill.approved to the bill submitter (requestedBy)", async () => {
      const { svc, dispatch } = await buildService({
        approvalReq: { requestedBy: SUBMITTER_USER_ID },
      });

      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventKey: "accounting.bill.approved",
          orgId: ORG_ID,
          targetUserIds: [SUBMITTER_USER_ID],
          actorUserId: APPROVER_USER_ID,
          entityType: "purchase_bill",
          entityId: String(BILL_ID),
        }),
      );
    });

    it("does NOT dispatch to the approver (actor_user_id is not the target)", async () => {
      const { svc, dispatch } = await buildService({
        approvalReq: { requestedBy: SUBMITTER_USER_ID },
      });

      await svc.handle(makeEvent());

      const callArg = (dispatch.emitDurable as jest.Mock).mock.calls[0]?.[1] as
        | { targetUserIds: string[] }
        | undefined;
      expect(callArg?.targetUserIds).not.toContain(APPROVER_USER_ID);
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
