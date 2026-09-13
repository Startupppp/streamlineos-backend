import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { ExternalEffectLedger, ExternalEffectLeaseBusyError } from "../../../common/outbox/external-effect-ledger";
import { ComposioGateway } from "../../integrations/core/composio.gateway";
import { IntegrationConnectionDisconnectedConsumer } from "./integration-connection-disconnected-consumer.service";

const ORG_ID = "org-integration-1";
const EVENT_ID = "evt-integration-aaa";
const CONNECTION_ID = 42;
const COMPOSIO_ACCOUNT_ID = "composio-account-xyz";
const USER_ID = "user-owner";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "user_integration_connection",
    aggregateId: String(CONNECTION_ID),
    aggregateVersion: 1,
    eventType: "integration.connection.disconnected",
    payload: {
      connectionId: CONNECTION_ID,
      composioConnectedAccountId: COMPOSIO_ACCOUNT_ID,
      userId: USER_ID,
      orgId: ORG_ID,
      cause: "user_revoked",
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
  deleteImpl?: () => Promise<void>;
  effectsOverride?: { execute: jest.Mock };
}) {
  const { deleteImpl = async () => undefined, effectsOverride } = options;
  const db = buildDbMock(options);
  const composio = {
    deleteConnectedAccount: jest.fn().mockImplementation(deleteImpl),
  } as unknown as ComposioGateway;
  const registry = new OutboxConsumerRegistry();
  const effects = effectsOverride ?? {
    execute: jest.fn().mockImplementation(async (_e: unknown, send: () => Promise<void>) => {
      await send();
      return "EXECUTED" as const;
    }),
  };

  const module = await Test.createTestingModule({
    providers: [
      IntegrationConnectionDisconnectedConsumer,
      { provide: DRIZZLE, useValue: db },
      { provide: ComposioGateway, useValue: composio },
      { provide: OutboxConsumerRegistry, useValue: registry },
      { provide: ExternalEffectLedger, useValue: effects },
    ],
  }).compile();

  const svc = module.get(IntegrationConnectionDisconnectedConsumer);
  return { svc, db, composio, registry, effects };
}

describe("IntegrationConnectionDisconnectedConsumer", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = integration.connection.disconnected", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("integration.connection.disconnected");
    });
  });

  describe("B1 — consumer correctness", () => {
    it("calls composio.deleteConnectedAccount with the composioConnectedAccountId from the payload", async () => {
      const { svc, composio } = await buildService({});

      await svc.handle(makeEvent());

      expect(composio.deleteConnectedAccount).toHaveBeenCalledWith(COMPOSIO_ACCOUNT_ID);
    });

    it("marks inbox COMPLETED after a successful Composio deletion", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });

    it("skips Composio call and marks SKIPPED when composioConnectedAccountId is null", async () => {
      const { svc, composio, db } = await buildService({});
      const event = makeEvent({
        payload: {
          connectionId: CONNECTION_ID,
          composioConnectedAccountId: null,
          userId: USER_ID,
          orgId: ORG_ID,
          cause: "user_revoked",
        },
      });

      await svc.handle(event);

      expect(composio.deleteConnectedAccount).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("processes events using only event.organizationId — no ambient context required", async () => {
      const { svc, composio } = await buildService({});
      const isolatedOrg = "org-isolated";
      const event = makeEvent({
        organizationId: isolatedOrg,
        payload: {
          connectionId: CONNECTION_ID,
          composioConnectedAccountId: COMPOSIO_ACCOUNT_ID,
          userId: USER_ID,
          orgId: isolatedOrg,
          cause: "user_revoked",
        },
      });

      await svc.handle(event);

      expect(composio.deleteConnectedAccount).toHaveBeenCalledWith(COMPOSIO_ACCOUNT_ID);
    });
  });

  describe("B3 — transient Composio failure", () => {
    it("marks inbox FAILED when Composio deleteConnectedAccount throws", async () => {
      const { svc, db } = await buildService({
        deleteImpl: async () => { throw new Error("composio unavailable"); },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("composio unavailable");

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });

    it("records the Composio error message in the inbox lastError field", async () => {
      const { svc, db } = await buildService({
        deleteImpl: async () => { throw new Error("composio-specific-error"); },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("composio-specific-error");

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: "composio-specific-error" }),
      );
    });
  });

  describe("B4 — duplicate suppression", () => {
    it("does not call Composio when the inbox claim is already taken", async () => {
      const { svc, composio } = await buildService({ claimed: false });

      await svc.handle(makeEvent());

      expect(composio.deleteConnectedAccount).not.toHaveBeenCalled();
    });

    it("delivering the same event twice only contacts Composio once", async () => {
      const { svc, composio } = await buildService({ claimed: false });

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(composio.deleteConnectedAccount).not.toHaveBeenCalled();
    });
  });

  describe("B5 — DLQ replay: stable side effect on retry", () => {
    it("contacts Composio again on retry with the same account id", async () => {
      const deleteAccount = jest.fn()
        .mockRejectedValueOnce(new Error("transient network error"))
        .mockResolvedValueOnce(undefined);
      const { svc } = await buildService({ deleteImpl: deleteAccount });

      await expect(svc.handle(makeEvent())).rejects.toThrow("transient network error");
      await svc.handle(makeEvent());

      expect(deleteAccount).toHaveBeenCalledTimes(2);
      expect(deleteAccount.mock.calls[0]?.[0]).toBe(COMPOSIO_ACCOUNT_ID);
      expect(deleteAccount.mock.calls[1]?.[0]).toBe(COMPOSIO_ACCOUNT_ID);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED and does not call Composio when payload is invalid", async () => {
      const { svc, composio, db } = await buildService({});
      const bad = makeEvent({ payload: { invalid: true } });

      await svc.handle(bad);

      expect(composio.deleteConnectedAccount).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });
  });

  describe("ledger fence", () => {
    it("propagates BUSY when an abandoned in-flight delete holds the lease — no duplicate Composio call", async () => {
      const busyEffects = {
        execute: jest.fn().mockRejectedValueOnce(
          new ExternalEffectLeaseBusyError(`outbox:${ORG_ID}:integration:connection-disconnected:${EVENT_ID}`),
        ),
      };
      const { svc, composio, db } = await buildService({ effectsOverride: busyEffects });

      await expect(svc.handle(makeEvent())).rejects.toBeInstanceOf(ExternalEffectLeaseBusyError);
      expect(composio.deleteConnectedAccount).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED" }));
    });

    it("suppresses the Composio call and marks COMPLETED when the effect already SUCCEEDED", async () => {
      const succeededEffects = {
        execute: jest.fn().mockResolvedValueOnce("ALREADY_SUCCEEDED" as const),
      };
      const { svc, composio, db } = await buildService({ effectsOverride: succeededEffects });

      await svc.handle(makeEvent());
      expect(composio.deleteConnectedAccount).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(expect.objectContaining({ status: "COMPLETED" }));
    });
  });
});
