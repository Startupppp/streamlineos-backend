import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { SupportCsatService } from "./support-csat.service";
import { SupportTicketResolvedConsumer } from "./support-ticket-resolved-consumer.service";

const ORG_ID = "org-support-1";
const EVENT_ID = "evt-support-aaa";
const TICKET_ID = 55;
const ACTOR_USER_ID = "user-agent";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "support_ticket",
    aggregateId: String(TICKET_ID),
    aggregateVersion: 1,
    eventType: "support.ticket.resolved",
    payload: {
      ticketId: TICKET_ID,
      orgId: ORG_ID,
      actorUserId: ACTOR_USER_ID,
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

interface DbMock {
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
}

function buildDbMock(options: { claimed?: boolean }): DbMock {
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

async function buildService(options: {
  claimed?: boolean;
  csatImpl?: () => Promise<void>;
}) {
  const { csatImpl = async () => undefined } = options;
  const db = buildDbMock(options);
  const csat = {
    createRequestForTicket: jest.fn().mockImplementation(csatImpl),
  } as unknown as SupportCsatService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      SupportTicketResolvedConsumer,
      { provide: DRIZZLE, useValue: db },
      { provide: SupportCsatService, useValue: csat },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(SupportTicketResolvedConsumer);
  return { svc, db, csat, registry };
}

describe("SupportTicketResolvedConsumer", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = support.ticket.resolved", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("support.ticket.resolved");
    });
  });

  describe("B1 — consumer correctness", () => {
    it("calls csat.createRequestForTicket with orgId and ticketId from the event", async () => {
      const { svc, csat } = await buildService({});

      await svc.handle(makeEvent());

      expect(csat.createRequestForTicket).toHaveBeenCalledWith(ORG_ID, TICKET_ID);
    });

    it("marks inbox COMPLETED after successful CSAT request creation", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });

    it("marks SKIPPED and does not fail when the ticket is not found (NotFoundException)", async () => {
      const { svc, db } = await buildService({
        csatImpl: async () => { throw new NotFoundException("ticket not found"); },
      });

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("uses event.organizationId for CSAT creation — safe without ambient request context", async () => {
      const { svc, csat } = await buildService({});
      const isolatedOrg = "org-isolated-csat";
      const event = makeEvent({
        organizationId: isolatedOrg,
        payload: { ticketId: TICKET_ID, orgId: isolatedOrg, actorUserId: ACTOR_USER_ID },
      });

      await svc.handle(event);

      expect(csat.createRequestForTicket).toHaveBeenCalledWith(isolatedOrg, TICKET_ID);
    });
  });

  describe("B3 — transient CSAT service failure", () => {
    it("marks inbox FAILED when createRequestForTicket throws a non-NotFoundException", async () => {
      const { svc, db } = await buildService({
        csatImpl: async () => { throw new Error("database connection lost"); },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("database connection lost");

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });

    it("records the transient error message in the inbox lastError field", async () => {
      const { svc, db } = await buildService({
        csatImpl: async () => { throw new Error("transient-csat-error"); },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("transient-csat-error");

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: "transient-csat-error" }),
      );
    });
  });

  describe("B4 — duplicate suppression", () => {
    it("does not create a CSAT request when the inbox claim is already taken", async () => {
      const { svc, csat } = await buildService({ claimed: false });

      await svc.handle(makeEvent());

      expect(csat.createRequestForTicket).not.toHaveBeenCalled();
    });

    it("delivering the same event twice creates only one CSAT request", async () => {
      const { svc, csat } = await buildService({ claimed: false });

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(csat.createRequestForTicket).not.toHaveBeenCalled();
    });
  });

  describe("B5 — DLQ replay: idempotent CSAT creation", () => {
    it("calls createRequestForTicket again on retry after a transient failure", async () => {
      const csatFn = jest.fn()
        .mockRejectedValueOnce(new Error("transient network failure"))
        .mockResolvedValueOnce(undefined);
      const { svc } = await buildService({ csatImpl: csatFn });

      await expect(svc.handle(makeEvent())).rejects.toThrow("transient network failure");
      await svc.handle(makeEvent());

      expect(csatFn).toHaveBeenCalledTimes(2);
      expect(csatFn.mock.calls[0]).toEqual([ORG_ID, TICKET_ID]);
      expect(csatFn.mock.calls[1]).toEqual([ORG_ID, TICKET_ID]);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED and does not call CSAT when payload is invalid", async () => {
      const { svc, csat, db } = await buildService({});
      const bad = makeEvent({ payload: { invalid: true } });

      await svc.handle(bad);

      expect(csat.createRequestForTicket).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });
  });
});
