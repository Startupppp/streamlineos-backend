jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (_db: unknown, fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(_db),
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => fn(_db),
}));

jest.mock("../../common/outbox/inbox-consumer", () => ({
  InboxConsumer: jest.fn(),
}));

jest.mock("../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn().mockResolvedValue({ allowed: true }),
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { InboxConsumer } from "../../common/outbox/inbox-consumer";
import { InventoryWebhookEmitter } from "../inventory/webhooks/webhook-emitter.service";
import { SignEnvelopeCompletedConsumerService } from "./sign-envelope-completed-consumer.service";
import { OutboxConsumerRegistry } from "../../common/outbox/outbox-consumer.registry";
import type { OutboxEventRow } from "../../common/outbox/outbox-consumer.registry";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { checkWebhookUrl } from "../../common/security/ssrf-guard";

const ATTACKER_ORG = "org-attacker";
const OWNER_ORG = "org-owner";

const MockInboxConsumer = InboxConsumer as jest.MockedClass<typeof InboxConsumer>;

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

beforeEach(() => jest.resetAllMocks());

// ---------------------------------------------------------------------------
// InventoryWebhookEmitter
// ---------------------------------------------------------------------------

describe("InventoryWebhookEmitter — tenant isolation", () => {
  function makeSelectChain(rows: unknown[]) {
    let capturedPredicate: unknown;
    const where = jest.fn().mockImplementation((predicate: unknown) => {
      capturedPredicate = predicate;
      return Promise.resolve(rows);
    });
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({ where }),
        }),
      }),
      insert: jest.fn(),
      update: jest.fn(),
    } as unknown as Db;
    return { db, where, getPredicate: () => capturedPredicate };
  }

  it("DENY: emit queries only ATTACKER_ORG's webhooks and returns without inserting when none match", async () => {
    const { db, getPredicate } = makeSelectChain([]);
    const service = new InventoryWebhookEmitter(db);

    await service.emit(ATTACKER_ORG, "inventory.product.created", { itemId: 1 }, {});

    expect(sqlValues(getPredicate())).toContain(ATTACKER_ORG);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("CONTROL: emit queries OWNER_ORG's webhooks, inserts an event, and delivers", async () => {
    const eventRow = { id: 7, attempts: 0, createdAt: new Date() };
    const returning = jest.fn().mockResolvedValue([eventRow]);
    // The emitter dedupes on insert: .values().onConflictDoNothing().returning().
    const insertValues = jest.fn().mockReturnValue({
      returning,
      onConflictDoNothing: jest.fn().mockReturnValue({ returning }),
    });
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const updateSet = jest.fn().mockReturnValue({ where: updateWhere });

    const { db, getPredicate } = makeSelectChain([
      { id: 42, url: "https://example.com/hook", secret: "s3cr3t" },
    ]);
    const dbMut = db as unknown as { insert: jest.Mock; update: jest.Mock };
    dbMut.insert = jest.fn().mockReturnValue({ values: insertValues });
    dbMut.update = jest.fn().mockReturnValue({ set: updateSet });

    (checkWebhookUrl as jest.Mock).mockResolvedValue({ allowed: true });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, type: "basic" } as unknown as Response);

    const service = new InventoryWebhookEmitter(db);

    await service.emit(OWNER_ORG, "inventory.product.created", { itemId: 2 }, {});

    expect(sqlValues(getPredicate())).toContain(OWNER_ORG);
    expect(db.insert).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SignEnvelopeCompletedConsumerService
// ---------------------------------------------------------------------------

describe("SignEnvelopeCompletedConsumerService — tenant isolation", () => {
  function buildEvent(orgId: string, envelopeId: number): OutboxEventRow {
    return {
      eventId: `evt-${envelopeId}`,
      organizationId: orgId,
      eventType: "sign.envelope.completed",
      aggregateType: "sign_envelope",
      aggregateId: String(envelopeId),
      aggregateVersion: 1,
      payload: { envelopeId, orgId },
    } as unknown as OutboxEventRow;
  }

  async function buildService(db: Db, dispatch: NotificationDispatchService) {
    const registry = { register: jest.fn() } as unknown as OutboxConsumerRegistry;
    const module = await Test.createTestingModule({
      providers: [
        SignEnvelopeCompletedConsumerService,
        { provide: DRIZZLE, useValue: db },
        { provide: OutboxConsumerRegistry, useValue: registry },
        { provide: NotificationDispatchService, useValue: dispatch },
      ],
    }).compile();
    return module.get(SignEnvelopeCompletedConsumerService);
  }

  it("DENY: handle returns early without dispatching when the inbox record is already claimed", async () => {
    const mockClaim = jest.fn().mockResolvedValue(false);
    const mockMarkProcessed = jest.fn().mockResolvedValue(undefined);
    MockInboxConsumer.mockImplementation(() => ({
      claim: mockClaim,
      markProcessed: mockMarkProcessed,
    }) as unknown as InboxConsumer);

    const db = {
      query: { signEnvelopes: { findFirst: jest.fn() } },
      insert: jest.fn(),
      update: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;

    const service = await buildService(db, dispatch);
    await service.handle(buildEvent(ATTACKER_ORG, 99));

    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(dispatch.emit).not.toHaveBeenCalled();
    expect(db.query.signEnvelopes.findFirst).not.toHaveBeenCalled();
  });

  it("CONTROL: handle dispatches a notification to the envelope sender when the event is claimed", async () => {
    const mockClaim = jest.fn().mockResolvedValue(true);
    const mockMarkProcessed = jest.fn().mockResolvedValue(undefined);
    MockInboxConsumer.mockImplementation(() => ({
      claim: mockClaim,
      markProcessed: mockMarkProcessed,
    }) as unknown as InboxConsumer);

    const db = {
      query: {
        signEnvelopes: {
          findFirst: jest.fn().mockResolvedValue({ senderMembershipId: 10, orgId: OWNER_ORG, title: "Contract" }),
        },
        organizationMembers: {
          findFirst: jest.fn().mockResolvedValue({ user: { id: "user-sender" } }),
        },
      },
      insert: jest.fn(),
      update: jest.fn(),
      execute: jest.fn().mockResolvedValue([]),
    } as unknown as Db;
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationDispatchService;

    const service = await buildService(db, dispatch);
    await service.handle(buildEvent(OWNER_ORG, 55));

    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    expect(dispatch.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: OWNER_ORG,
        eventKey: "sign.document.completed",
        targetUserIds: ["user-sender"],
      }),
    );
    expect(mockMarkProcessed).toHaveBeenCalledWith(
      "sign:envelope-completed",
      "evt-55",
      "COMPLETED",
      null,
    );
  });
});
