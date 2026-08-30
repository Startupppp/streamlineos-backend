import { Test } from "@nestjs/testing";
import { ReminderOutboxConsumer } from "./reminder-outbox.consumer";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { INVOICE_REMINDER_EVENT } from "./dto/reminder-outbox.schemas";

const ORG_ID = "org-reminder-1";
const OTHER_ORG = "org-reminder-2";
const EVENT_ID = "evt-reminder-aaa";
const INVOICE_ID = 99;
const REMINDER_LOG_ID = 7;

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "fin_reminder_log",
    aggregateId: String(REMINDER_LOG_ID),
    aggregateVersion: 1,
    eventType: INVOICE_REMINDER_EVENT,
    payload: {
      orgId: ORG_ID,
      reminderLogId: REMINDER_LOG_ID,
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-0099",
      channel: "EMAIL",
      offsetDays: 3,
      targetUserIds: ["user-a", "user-b"],
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

function buildDbMock(options: { claimed?: boolean; activeRecipients?: string[] }) {
  const { claimed = true, activeRecipients = ["user-a"] } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const recipientRows = activeRecipients.map((userId) => ({ userId }));
  const dbSelect = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(recipientRows),
    }),
  });

  return { insert: dbInsert, update: dbUpdate, select: dbSelect };
}

async function buildSvc(options: {
  claimed?: boolean;
  activeRecipients?: string[];
  emitImpl?: () => Promise<void>;
}) {
  const { emitImpl = async () => undefined } = options;
  const db = buildDbMock(options);
  const dispatch = { emit: jest.fn().mockImplementation(emitImpl) } as unknown as NotificationDispatchService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      ReminderOutboxConsumer,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const consumer = module.get(ReminderOutboxConsumer);
  return { consumer, db, dispatch, registry };
}

describe("ReminderOutboxConsumer", () => {
  describe("registration", () => {
    it("registers itself with the registry on module init", async () => {
      const { consumer, registry } = await buildSvc({});
      const spy = jest.spyOn(registry, "register");
      consumer.onModuleInit();
      expect(spy).toHaveBeenCalledWith(consumer);
    });

    it("declares the correct eventType constant", async () => {
      const { consumer } = await buildSvc({});
      expect(consumer.eventType).toBe(INVOICE_REMINDER_EVENT);
    });
  });

  describe("claim fence — exactly-once delivery", () => {
    it("returns without dispatching when the inbox claim is already taken", async () => {
      const { consumer, dispatch } = await buildSvc({ claimed: false });
      await consumer.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("does not call db.update when the claim fence fires", async () => {
      const { consumer, db } = await buildSvc({ claimed: false });
      await consumer.handle(makeEvent());
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("payload validation", () => {
    it("marks inbox SKIPPED when the payload is not a valid reminder schema", async () => {
      const { consumer, db } = await buildSvc({});
      const bad = makeEvent();
      (bad.payload as Record<string, unknown>)["reminderLogId"] = "not-a-number";
      await consumer.handle(bad);
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });

    it("marks inbox SKIPPED when payload orgId does not match event organizationId", async () => {
      const { consumer, db } = await buildSvc({});
      const mismatched = makeEvent({ organizationId: OTHER_ORG });
      await consumer.handle(mismatched);
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });

    it("does not dispatch a notification when payload is invalid", async () => {
      const { consumer, dispatch } = await buildSvc({});
      const bad = makeEvent();
      (bad.payload as Record<string, unknown>)["invoiceId"] = null;
      await consumer.handle(bad);
      expect(dispatch.emit).not.toHaveBeenCalled();
    });
  });

  describe("zero active recipients", () => {
    it("does not dispatch when none of the targetUserIds are active members", async () => {
      const { consumer, dispatch } = await buildSvc({ activeRecipients: [] });
      await consumer.handle(makeEvent());
      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("marks the reminder log SKIPPED when no recipients are active", async () => {
      const { consumer, db } = await buildSvc({ activeRecipients: [] });
      await consumer.handle(makeEvent());
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SKIPPED" }));
    });
  });

  describe("happy path", () => {
    it("dispatches the reminder notification to active recipients", async () => {
      const { consumer, dispatch } = await buildSvc({ activeRecipients: ["user-a"] });
      await consumer.handle(makeEvent());
      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "accounting.invoice.overdue",
          orgId: ORG_ID,
          targetUserIds: ["user-a"],
          entityType: "invoice",
          entityId: String(INVOICE_ID),
        }),
      );
    });

    it("marks the reminder log SENT on successful dispatch", async () => {
      const { consumer, db } = await buildSvc({ activeRecipients: ["user-a"] });
      await consumer.handle(makeEvent());
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "SENT" }));
    });
  });

  describe("error propagation", () => {
    it("marks the reminder log FAILED and rethrows on dispatch error", async () => {
      const { consumer, db } = await buildSvc({
        activeRecipients: ["user-a"],
        emitImpl: async () => {
          throw new Error("SMTP failure");
        },
      });
      await expect(consumer.handle(makeEvent())).rejects.toThrow("SMTP failure");
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });
  });
});
