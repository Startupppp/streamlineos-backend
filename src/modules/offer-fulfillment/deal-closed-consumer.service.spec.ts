import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { OutboxConsumerRegistry, type OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { NumberSequenceService } from "../inventory/stock-engine/number-sequence.service";
import { DealClosedConsumerService } from "./deal-closed-consumer.service";

const ORG_ID = "org-deal-1";
const EVENT_ID = "evt-deal-aaa";
const DEAL_ID = 10;
const SKU_ID = 1;
const ACTOR_USER_ID = "user-salesperson";

function makeEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: ORG_ID,
    aggregateType: "deal",
    aggregateId: String(DEAL_ID),
    aggregateVersion: 1,
    eventType: "deal.closed",
    payload: {
      dealId: DEAL_ID,
      orgId: ORG_ID,
      dealName: "Enterprise Deal",
      dealValue: "50000",
      closedAt: "2026-08-31",
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

interface TxMock {
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
}

interface DbMock {
  insert: jest.Mock;
  update: jest.Mock;
  execute: jest.Mock;
  select: jest.Mock;
  transaction: jest.Mock;
  tx: TxMock;
}

function buildDbMock(options: {
  claimed?: boolean;
  mappings?: Array<{ invSkuId: number; quantityPerUnit: string }>;
  variants?: Array<{ id: number; sellingPrice: string }>;
  txError?: Error;
} = {}): DbMock {
  const {
    claimed = true,
    mappings = [{ invSkuId: SKU_ID, quantityPerUnit: "1.0000" }],
    variants = [{ id: SKU_ID, sellingPrice: "5000" }],
    txError,
  } = options;

  const claimReturn = claimed ? [{ id: 1 }] : [];
  const claimReturning = jest.fn().mockResolvedValue(claimReturn);
  const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
  const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
  const dbInsert = jest.fn().mockReturnValue({ values: claimValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });

  const dbExecute = jest.fn().mockResolvedValue([]);

  const dbSelect = jest.fn()
    .mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(mappings),
        }),
      }),
    })
    .mockReturnValueOnce({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(variants),
      }),
    });

  const txInsertValues = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 99 }]),
  });
  const txInsert = jest.fn().mockReturnValue({ values: txInsertValues });

  const txUpdateWhere = jest.fn().mockResolvedValue(undefined);
  const txUpdateSet = jest.fn().mockReturnValue({ where: txUpdateWhere });
  const txUpdate = jest.fn().mockReturnValue({ set: txUpdateSet });

  const txExecute = jest.fn().mockResolvedValue([]);
  const tx: TxMock = { insert: txInsert, update: txUpdate, execute: txExecute };

  const dbTx = txError
    ? jest.fn().mockRejectedValue(txError)
    : jest.fn().mockImplementation(async (fn: (tx: TxMock) => Promise<unknown>) => fn(tx));

  return {
    insert: dbInsert,
    update: dbUpdate,
    execute: dbExecute,
    select: dbSelect,
    transaction: dbTx,
    tx,
  };
}

async function buildService(options: {
  claimed?: boolean;
  mappings?: Array<{ invSkuId: number; quantityPerUnit: string }>;
  variants?: Array<{ id: number; sellingPrice: string }>;
  txError?: Error;
  numSeqImpl?: () => Promise<string>;
}) {
  const { numSeqImpl = async () => "SO-001" } = options;
  const db = buildDbMock(options);
  const numSeq = {
    next: jest.fn().mockImplementation(numSeqImpl),
  } as unknown as NumberSequenceService;
  const registry = new OutboxConsumerRegistry();

  const module = await Test.createTestingModule({
    providers: [
      DealClosedConsumerService,
      { provide: DRIZZLE, useValue: db },
      { provide: NumberSequenceService, useValue: numSeq },
      { provide: OutboxConsumerRegistry, useValue: registry },
    ],
  }).compile();

  const svc = module.get(DealClosedConsumerService);
  return { svc, db, numSeq, registry };
}

describe("DealClosedConsumerService", () => {
  describe("registration", () => {
    it("registers itself with the OutboxConsumerRegistry on init", async () => {
      const { svc, registry } = await buildService({});
      const spy = jest.spyOn(registry, "register");
      svc.onModuleInit();
      expect(spy).toHaveBeenCalledWith(svc);
    });

    it("declares eventType = deal.closed", async () => {
      const { svc } = await buildService({});
      expect(svc.eventType).toBe("deal.closed");
    });
  });

  describe("B1 — consumer correctness", () => {
    it("invokes db.transaction to create the SO when active mappings exist", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it("inserts the sales order header inside the transaction callback", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      expect(db.tx.insert).toHaveBeenCalled();
    });

    it("marks inbox COMPLETED inside the transaction after SO insertion", async () => {
      const { svc, db } = await buildService({});

      await svc.handle(makeEvent());

      const setArg = (db.tx.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "COMPLETED" }),
      );
    });

    it("marks inbox SKIPPED when no active offer-fulfillment mappings exist", async () => {
      const { svc, db } = await buildService({ mappings: [] });

      await svc.handle(makeEvent());

      expect(db.transaction).not.toHaveBeenCalled();
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });

    it("marks inbox SKIPPED when mapped SKUs are absent from the org product variants", async () => {
      const { svc, db } = await buildService({ variants: [] });

      await svc.handle(makeEvent());

      expect(db.transaction).not.toHaveBeenCalled();
      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "SKIPPED" }),
      );
    });
  });

  describe("B2 — no ambient tenant context needed", () => {
    it("uses event.organizationId for fulfillment mapping queries — safe without ambient context", async () => {
      const { svc, db } = await buildService({});
      const isolatedOrg = "org-isolated-deal";

      await svc.handle(makeEvent({
        organizationId: isolatedOrg,
        payload: {
          dealId: DEAL_ID,
          orgId: isolatedOrg,
          dealName: "Isolated Deal",
          dealValue: "10000",
          closedAt: "2026-08-31",
          actorUserId: ACTOR_USER_ID,
        },
      }));

      expect(db.select).toHaveBeenCalled();
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  describe("B3 — transient failure in transaction", () => {
    it("marks inbox FAILED when the database transaction throws", async () => {
      const { svc, db } = await buildService({ txError: new Error("tx rollback — deadlock") });

      await svc.handle(makeEvent());

      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
    });

    it("records the transaction error message in the inbox lastError field", async () => {
      const { svc, db } = await buildService({ txError: new Error("specific-tx-error") });

      await svc.handle(makeEvent());

      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ lastError: "specific-tx-error" }),
      );
    });
  });

  describe("B4 — duplicate suppression", () => {
    it("does not query fulfillment mappings when the inbox claim is already taken", async () => {
      const { svc, db } = await buildService({ claimed: false });

      await svc.handle(makeEvent());

      expect(db.select).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("delivering the same event twice does not create a second SO", async () => {
      const { svc, db } = await buildService({ claimed: false });

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  describe("B5 — DLQ replay: SO creation retried on relay re-delivery", () => {
    it("calls the transaction callback again when the relay re-delivers after a failure", async () => {
      let numSeqCallCount = 0;
      const numSeqFn = jest.fn().mockImplementation(async () => {
        numSeqCallCount += 1;
        if (numSeqCallCount === 1) throw new Error("sequence service transient failure");
        return "SO-001";
      });

      let selectCallCount = 0;
      const dbSelect = jest.fn().mockImplementation(() => {
        selectCallCount += 1;
        const isMappings = selectCallCount % 2 !== 0;
        if (isMappings) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ invSkuId: SKU_ID, quantityPerUnit: "1.0000" }]),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ id: SKU_ID, sellingPrice: "5000" }]),
          }),
        };
      });

      const claimReturn = [{ id: 1 }];
      const claimReturning = jest.fn().mockResolvedValue(claimReturn);
      const claimOnConflict = jest.fn().mockReturnValue({ returning: claimReturning });
      const claimValues = jest.fn().mockReturnValue({ onConflictDoNothing: claimOnConflict });
      const dbInsert = jest.fn().mockReturnValue({ values: claimValues });
      const updateWhere = jest.fn().mockResolvedValue(undefined);
      const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
      const dbUpdate = jest.fn().mockReturnValue({ set: updateSet });
      const dbExecute = jest.fn().mockResolvedValue([]);

      const txInsert = jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 99 }]) }),
      });
      const txUpdate = jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      });
      const tx = { insert: txInsert, update: txUpdate, execute: jest.fn().mockResolvedValue([]) };

      const txMock = jest.fn().mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

      const db = { insert: dbInsert, update: dbUpdate, execute: dbExecute, select: dbSelect, transaction: txMock };
      const numSeq = { next: numSeqFn } as unknown as NumberSequenceService;
      const registry = new OutboxConsumerRegistry();

      const module = await Test.createTestingModule({
        providers: [
          DealClosedConsumerService,
          { provide: DRIZZLE, useValue: db },
          { provide: NumberSequenceService, useValue: numSeq },
          { provide: OutboxConsumerRegistry, useValue: registry },
        ],
      }).compile();

      const svc = module.get(DealClosedConsumerService);

      await svc.handle(makeEvent());
      await svc.handle(makeEvent());

      expect(txMock).toHaveBeenCalledTimes(2);
      expect(numSeqFn).toHaveBeenCalledTimes(2);
    });
  });

  describe("payload validation", () => {
    it("marks inbox FAILED when payload is missing required dealId", async () => {
      const { svc, db } = await buildService({});
      const bad = makeEvent({ payload: { orgId: ORG_ID } });

      await svc.handle(bad);

      const setArg = (db.update as jest.Mock).mock.results[0]?.value as { set: jest.Mock } | undefined;
      expect(setArg?.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "FAILED" }),
      );
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
});
