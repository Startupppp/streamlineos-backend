import { InvStockLowConsumerService } from "./inv-stock-low-consumer.service";
import { OutboxConsumerRegistry } from "../../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AccessService } from "../../access/access.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { Test } from "@nestjs/testing";

const ORG_ID = "org-inv-1";
const EVENT_ID = "evt-inv-low-001";
const VARIANT_ID = 42;
const USER_ID_A = "user-inv-a";
const USER_ID_B = "user-inv-b";

function makeEvent(): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "inv_product_variant",
    aggregateId: String(VARIANT_ID),
    aggregateVersion: 1,
    eventType: "inventory.stock.low",
    payload: {
      productVariantId: VARIANT_ID,
      onHand: "5",
      reorderPoint: "10",
      sourceType: "sale",
      sourceId: "so-123",
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

interface DbMock {
  insert: jest.Mock;
  update: jest.Mock;
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

  return { insert: dbInsert, update: dbUpdate };
}

async function buildService(options: {
  claimed?: boolean;
  members?: { userId: string; membershipId: number }[];
  emitDurableImpl?: () => Promise<void>;
}) {
  const {
    members = [
      { userId: USER_ID_A, membershipId: 1 },
      { userId: USER_ID_B, membershipId: 2 },
    ],
    emitDurableImpl = async () => undefined,
  } = options;

  const db = buildDbMock(options);

  const dispatch = {
    emitDurable: jest.fn().mockImplementation(emitDurableImpl),
  } as unknown as NotificationDispatchService;

  const access = {
    membersWithPermission: jest.fn().mockResolvedValue(members),
  } as unknown as AccessService;

  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      InvStockLowConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NotificationDispatchService, useValue: dispatch },
      { provide: OutboxConsumerRegistry, useValue: registry },
      { provide: AccessService, useValue: access },
    ],
  }).compile();

  const svc = module.get(InvStockLowConsumerService);

  return { svc, db, dispatch, access, registry };
}

describe("InvStockLowConsumerService", () => {
  describe("onModuleInit", () => {
    it("registers itself with the OutboxConsumerRegistry", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = inventory.stock.low", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("inventory.stock.low");
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
      (badEvent.payload as Record<string, unknown>)["productVariantId"] = "not-a-number";

      await svc.handle(badEvent);

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as
        | { set: jest.Mock }
        | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });
  });

  describe("zero recipients", () => {
    it("marks inbox SKIPPED and does not dispatch when no members hold the permission", async () => {
      const { svc, dispatch, db } = await buildService({ members: [] });
      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).not.toHaveBeenCalled();
      const setCall = (db.update as jest.Mock).mock.results[0]?.value as
        | { set: jest.Mock }
        | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("happy path", () => {
    it("dispatches inventory.stock.low to all members holding the permission", async () => {
      const { svc, dispatch } = await buildService({
        members: [
          { userId: USER_ID_A, membershipId: 1 },
          { userId: USER_ID_B, membershipId: 2 },
        ],
      });

      await svc.handle(makeEvent());

      expect(dispatch.emitDurable).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventKey: "inventory.stock.low",
          orgId: ORG_ID,
          targetUserIds: expect.arrayContaining([USER_ID_A, USER_ID_B]),
          entityType: "inv_product_variant",
          entityId: String(VARIANT_ID),
        }),
      );
    });

    it("resolves recipients using inventory:replenishment:manage permission key", async () => {
      const { svc, access } = await buildService({});
      await svc.handle(makeEvent());
      expect(access.membersWithPermission).toHaveBeenCalledWith(
        ORG_ID,
        "inventory:replenishment:manage",
      );
    });

    it("marks inbox COMPLETED on success", async () => {
      const { svc, db } = await buildService({});
      await svc.handle(makeEvent());

      const setCall = (db.update as jest.Mock).mock.results[0]?.value as
        | { set: jest.Mock }
        | undefined;
      expect(setCall?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });
  });

  describe("error propagation", () => {
    it("propagates a thrown error so the relay marks the outbox event RETRY, not DELIVERED", async () => {
      const { svc } = await buildService({
        emitDurableImpl: async () => {
          throw new Error("downstream failure");
        },
      });

      await expect(svc.handle(makeEvent())).rejects.toThrow("downstream failure");
    });
  });
});
