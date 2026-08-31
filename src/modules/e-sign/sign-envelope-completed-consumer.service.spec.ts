import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { SignEnvelopeCompletedConsumerService } from "./sign-envelope-completed-consumer.service";

const ORG_ID = "org-sign-1";
const EVENT_ID = "evt-sign-aaa";
const ENVELOPE_ID = 77;
const SENDER_USER_ID = "user-sender";
const TITLE = "NDA Agreement";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "sign_envelope",
    aggregateId: String(ENVELOPE_ID),
    aggregateVersion: 1,
    eventType: "sign.envelope.completed",
    payload: { envelopeId: ENVELOPE_ID, orgId: ORG_ID },
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

interface DbMock {
  insert: jest.Mock;
  update: jest.Mock;
  query: { signEnvelopes: { findFirst: jest.Mock } };
  execute: jest.Mock;
}

function buildDbMock(options: {
  claimed?: boolean;
  envelope?: { senderUserId: string; title: string } | null;
}): DbMock {
  const { claimed = true, envelope = { senderUserId: SENDER_USER_ID, title: TITLE } } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const dbExecute = jest.fn().mockResolvedValue([]);

  return {
    insert: dbInsert,
    update: dbUpdate,
    query: { signEnvelopes: { findFirst: jest.fn().mockResolvedValue(envelope) } },
    execute: dbExecute,
  };
}

async function buildService(options: {
  claimed?: boolean;
  envelope?: { senderUserId: string; title: string } | null;
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
      SignEnvelopeCompletedConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(SignEnvelopeCompletedConsumerService);
  return { svc, db, dispatch, registry };
}

describe("SignEnvelopeCompletedConsumerService", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = sign.envelope.completed", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("sign.envelope.completed");
    });
  });

  describe("B1 — consumer correctness", () => {
    it("dispatches sign.document.completed to the envelope sender", async () => {
      const { svc, dispatch } = await buildService({});

      await svc.handle(makeEvent());

      expect(dispatch.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: "sign.document.completed",
          orgId: ORG_ID,
          targetUserIds: [SENDER_USER_ID],
          entityType: "sign_envelope",
          entityId: String(ENVELOPE_ID),
          variables: { title: TITLE },
        }),
      );
    });

    it("marks inbox COMPLETED after successful dispatch", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });

    it("marks inbox SKIPPED and does not dispatch when the envelope is not found", async () => {
      const { svc, dispatch, db } = await buildService({ envelope: null });

      await svc.handle(makeEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("derives orgId from event.organizationId — scoped query uses the event org", async () => {
      const { svc, dispatch } = await buildService({});
      const isolatedOrg = "org-isolated";

      await svc.handle(makeEvent({ organizationId: isolatedOrg, payload: { envelopeId: ENVELOPE_ID, orgId: isolatedOrg } }));

      const emitCall = (dispatch.emit as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(emitCall?.orgId).toBe(isolatedOrg);
    });
  });

  describe("B3 — retry on transient failure", () => {
    it("propagates dispatch failure so the outbox relay retries the event", async () => {
      const { svc } = await buildService({
        emitImpl: async () => { throw new Error("notification service down"); },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("notification service down");
    });

    it("uses a stable idempotency key derived from org + consumer + event", async () => {
      const { svc, dispatch } = await buildService({});

      await svc.handle(makeEvent());
      await svc.handle(makeEvent({ eventId: "different-event" }));

      const call0 = (dispatch.emit as jest.Mock).mock.calls[0]?.[0] as { dedupeKey: string } | undefined;
      const call1 = (dispatch.emit as jest.Mock).mock.calls[1]?.[0] as { dedupeKey: string } | undefined;
      expect(call0?.dedupeKey).toContain(EVENT_ID);
      expect(call1?.dedupeKey).toContain("different-event");
      expect(call0?.dedupeKey).not.toBe(call1?.dedupeKey);
    });
  });

  describe("B4 — duplicate suppression", () => {
    it("does not dispatch when the inbox claim is already taken (duplicate redelivery)", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });

      await svc.handle(makeEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
    });

    it("delivering the same event twice dispatches only once", async () => {
      const { svc, dispatch } = await buildService({ claimed: false });

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(dispatch.emit).not.toHaveBeenCalled();
    });
  });

  describe("B5 — DLQ replay: stable idempotency key", () => {
    it("reuses the same dedupeKey when the relay retries after a worker crash — downstream is idempotent", async () => {
      const emitMock = jest.fn()
        .mockRejectedValueOnce(new Error("provider down"))
        .mockResolvedValueOnce(undefined);
      const { svc } = await buildService({ emitImpl: emitMock });

      await expect(svc.handle(makeEvent())).rejects.toThrow("provider down");
      await svc.handle(makeEvent());

      expect(emitMock).toHaveBeenCalledTimes(2);
      const key0 = (emitMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.dedupeKey;
      const key1 = (emitMock.mock.calls[1]?.[0] as Record<string, unknown> | undefined)?.dedupeKey;
      expect(key0).toBe(key1);
      expect(key0).toContain(ORG_ID);
      expect(key0).toContain(EVENT_ID);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED when envelopeId is not a valid number", async () => {
      const { svc, db } = await buildService({});
      const bad = makeEvent({ payload: { envelopeId: "not-a-number", orgId: ORG_ID } });

      await svc.handle(bad);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });

    it("does not dispatch when the payload is invalid", async () => {
      const { svc, dispatch } = await buildService({});
      await svc.handle(makeEvent({ payload: { orgId: ORG_ID } }));
      expect(dispatch.emit).not.toHaveBeenCalled();
    });
  });
});
