import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { expenses } from "../../db/schema";
import { outboxEvents } from "../../db/schema/common/outbox";
import { DRIZZLE } from "../../db/drizzle.constants";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { EmailService } from "../email/email.service";
import { AccessService } from "../access/access.service";
import { AutomationService } from "../automation/automation.service";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import {
  OutboxConsumerRegistry,
  type OutboxEventRow,
} from "../../common/outbox/outbox-consumer.registry";
import { type CreateExpenseInput } from "./dto/expense.schemas";
import { ExpensesWriteService } from "./expenses-write.service";
import { ExpenseDecidedConsumer, ExpenseSubmittedConsumer } from "./expense-outbox.consumer";
import {
  EXPENSE_DECIDED_EVENT,
  EXPENSE_SUBMITTED_EVENT,
  decisionEventKey,
} from "./dto/expense-outbox.schemas";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const ACTOR = "user-actor";
const SUBMITTER = "user-submitter";

interface RecordedInsert {
  table: string;
  values: Record<string, unknown>;
  handle: unknown;
  txOpen: boolean;
}

function tableName(table: unknown): string {
  if (table === expenses) return "expenses";
  if (table === outboxEvents) return "outbox_events";
  return "unknown";
}

function buildWriteDb(options: { failOutboxInsert?: boolean } = {}) {
  const inserts: RecordedInsert[] = [];
  const transactionCalls: unknown[] = [];
  const state = { txOpen: false, maxVersion: 0 };

  const makeHandle = (): Record<string, unknown> => {
    const handle: Record<string, unknown> = {};
    handle.select = () => ({
      from: () => ({
        where: () => Promise.resolve([{ maxVersion: state.maxVersion }]),
      }),
    });
    handle.insert = (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const name = tableName(table);
        if (name === "outbox_events") {
          inserts.push({ table: name, values, handle, txOpen: state.txOpen });
          if (options.failOutboxInsert) throw new Error("outbox insert failed");
          state.maxVersion = Number(values.aggregateVersion);
        } else {
          inserts.push({ table: name, values, handle, txOpen: state.txOpen });
        }
        const row = {
          id: 42,
          amount: "100.00",
          category: "TRAVEL",
          userId: SUBMITTER,
          createdAt: new Date("2026-08-29T10:00:00.000Z"),
          updatedAt: new Date("2026-08-29T10:00:00.000Z"),
        };
        const chain = {
          returning: () => Promise.resolve([row]),
          then: (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(undefined).then(resolve, reject),
        };
        return chain;
      },
    });
    return handle;
  };

  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const handle = makeHandle();
      transactionCalls.push(handle);
      state.txOpen = true;
      try {
        return await fn(handle);
      } finally {
        state.txOpen = false;
      }
    },
  };

  return { db, inserts, transactionCalls, makeHandle };
}

function buildConsumerDb(seed: { claimOutcome: "NEW" | "DUPLICATE" | "RETRY_FAILED" }) {
  const updates: Array<Record<string, unknown>> = [];
  let claimed = seed.claimOutcome !== "NEW";

  const db: Record<string, unknown> = {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => {
            if (claimed) return Promise.resolve([]);
            claimed = true;
            return Promise.resolve([{ id: 1 }]);
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return Promise.resolve(undefined);
        },
        returning: () => {
          updates.push(values);
          return Promise.resolve([{ id: 1 }]);
        },
      }),
    }),
    query: {
      users: { findFirst: () => Promise.resolve({ name: "Ada Lovelace" }) },
    },
  };

  if (seed.claimOutcome === "RETRY_FAILED") {
    db.execute = () => Promise.resolve([{ status: "FAILED", aggregateVersion: 1 }]);
    db.update = () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          updates.push(values);
          return {
            returning: () => Promise.resolve([{ id: 1 }]),
            then: (
              resolve: (value: unknown) => unknown,
              reject: (reason: unknown) => unknown,
            ) => Promise.resolve(undefined).then(resolve, reject),
          };
        },
      }),
    });
  }

  return { db, updates };
}

function outboxEvent(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: "11111111-1111-4111-8111-111111111111",
    organizationId: ORG,
    aggregateType: "expense",
    aggregateId: "42",
    aggregateVersion: 1787000000000,
    schemaVersion: 1,
    causationId: null,
    correlationId: null,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "IN_FLIGHT",
    eventType: EXPENSE_SUBMITTED_EVENT,
    payload: SUBMITTED_PAYLOAD,
    occurredAt: new Date("2026-08-29T10:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-08-29T10:00:00.000Z"),
    ...overrides,
  };
}

async function buildWriteService(db: unknown): Promise<ExpensesWriteService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ExpensesWriteService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: { invalidateNamespace: jest.fn() } },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: EmailService, useValue: {} },
      { provide: AccessService, useValue: { membersWithPermission: jest.fn() } },
    ],
  }).compile();
  return moduleRef.get(ExpensesWriteService);
}

const CREATE_INPUT: CreateExpenseInput = {
  category: "TRAVEL",
  amount: 100,
  description: "Client visit",
  expenseDate: "2026-08-20",
  merchant: undefined,
  paymentMethod: undefined,
};

const SUBMITTED_PAYLOAD = {
  expenseId: 42,
  orgId: ORG,
  actorUserId: ACTOR,
  amount: "100.00",
  category: "TRAVEL",
  description: null,
  recipients: { mode: "EXPENSE_APPROVERS" },
  runAutomations: true,
};

describe("expense outbox — atomicity", () => {
  it("commits the expense row and its outbox event on the same transaction handle", async () => {
    const { db, inserts, transactionCalls } = buildWriteDb();
    const service = await buildWriteService(db);

    await service.create(ORG, SUBMITTER, CREATE_INPUT);

    expect(transactionCalls).toHaveLength(1);
    expect(inserts.map((i) => i.table)).toEqual(["expenses", "outbox_events"]);
    expect(inserts[0]?.handle).toBe(inserts[1]?.handle);
    expect(inserts[1]?.handle).toBe(transactionCalls[0]);
    expect(inserts[0]?.txOpen).toBe(true);
    expect(inserts[1]?.txOpen).toBe(true);
  });

  it("the txOpen assertion discriminates — a write outside a transaction records false", async () => {
    const { inserts, makeHandle } = buildWriteDb();
    const handle = makeHandle();
    const insert = handle.insert;
    if (typeof insert !== "function") throw new Error("fake handle has no insert");

    await insert(expenses).values({ orgId: ORG });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.txOpen).toBe(false);
  });

  it("emits the submitted event type with an approver-resolution payload", async () => {
    const { db, inserts } = buildWriteDb();
    const service = await buildWriteService(db);

    await service.create(ORG, SUBMITTER, CREATE_INPUT);

    const event = inserts[1]?.values ?? {};
    expect(event.eventType).toBe(EXPENSE_SUBMITTED_EVENT);
    expect(event.organizationId).toBe(ORG);
    expect(event.aggregateType).toBe("expense");
    expect(event.aggregateId).toBe("42");
    expect(event.payload).toMatchObject({
      expenseId: 42,
      orgId: ORG,
      actorUserId: SUBMITTER,
      recipients: { mode: "EXPENSE_APPROVERS" },
      runAutomations: true,
    });
  });

  it("rolls the business write back when the outbox insert fails", async () => {
    const { db, inserts } = buildWriteDb({ failOutboxInsert: true });
    const service = await buildWriteService(db);

    await expect(service.create(ORG, SUBMITTER, CREATE_INPUT)).rejects.toThrow(
      "outbox insert failed",
    );
    expect(inserts.map((i) => i.table)).toEqual(["expenses", "outbox_events"]);
    expect(inserts[1]?.txOpen).toBe(true);
  });
});

describe("expense outbox — consumers", () => {
  const dispatch = { emit: jest.fn() };
  const automation = { runAutomationsForEvent: jest.fn() };
  const access = { membersWithPermission: jest.fn() };
  const registry = { register: jest.fn() };

  beforeEach(() => {
    dispatch.emit.mockReset().mockResolvedValue(undefined);
    automation.runAutomationsForEvent.mockReset().mockResolvedValue(undefined);
    access.membersWithPermission.mockReset().mockResolvedValue([{ userId: "user-approver" }]);
    registry.register.mockReset();
  });

  async function buildSubmittedConsumer(db: unknown): Promise<ExpenseSubmittedConsumer> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpenseSubmittedConsumer,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: AutomationService, useValue: automation },
        { provide: AccessService, useValue: access },
        { provide: OutboxConsumerRegistry, useValue: registry },
      ],
    }).compile();
    return moduleRef.get(ExpenseSubmittedConsumer);
  }

  async function buildDecidedConsumer(db: unknown): Promise<ExpenseDecidedConsumer> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExpenseDecidedConsumer,
        { provide: DRIZZLE, useValue: db },
        { provide: NotificationDispatchService, useValue: dispatch },
        { provide: OutboxConsumerRegistry, useValue: registry },
      ],
    }).compile();
    return moduleRef.get(ExpenseDecidedConsumer);
  }

  it("registers itself for its event type on module init", async () => {
    const { db } = buildConsumerDb({ claimOutcome: "NEW" });
    const consumer = await buildSubmittedConsumer(db);

    consumer.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(consumer);
    expect(consumer.eventType).toBe(EXPENSE_SUBMITTED_EVENT);
  });

  it("notifies resolved approvers once on first delivery", async () => {
    const { db } = buildConsumerDb({ claimOutcome: "NEW" });
    const consumer = await buildSubmittedConsumer(db);

    await consumer.handle(outboxEvent());

    expect(automation.runAutomationsForEvent).toHaveBeenCalledTimes(1);
    expect(dispatch.emit).toHaveBeenCalledTimes(1);
    const emitted = dispatch.emit.mock.calls[0]?.[0] ?? {};
    expect(emitted.eventKey).toBe("accounting.expense.submitted");
    expect(emitted.targetUserIds).toEqual(["user-approver"]);
    expect(emitted.dedupeKey).toBe(
      `outbox:${ORG}:expenses:submitted:11111111-1111-4111-8111-111111111111`,
    );
  });

  it("suppresses a duplicate redelivery of the same producer event", async () => {
    const { db } = buildConsumerDb({ claimOutcome: "DUPLICATE" });
    const consumer = await buildSubmittedConsumer(db);

    await consumer.handle(outboxEvent());

    expect(dispatch.emit).not.toHaveBeenCalled();
    expect(automation.runAutomationsForEvent).not.toHaveBeenCalled();
  });

  it("reclaims a previously failed delivery so the relay retry does real work", async () => {
    const { db } = buildConsumerDb({ claimOutcome: "RETRY_FAILED" });
    const consumer = await buildSubmittedConsumer(db);

    await consumer.handle(outboxEvent());

    expect(dispatch.emit).toHaveBeenCalledTimes(1);
  });

  it("refuses a payload whose organization does not match the event", async () => {
    const { db, updates } = buildConsumerDb({ claimOutcome: "NEW" });
    const consumer = await buildSubmittedConsumer(db);
    const event = outboxEvent({
      payload: { ...SUBMITTED_PAYLOAD, orgId: OTHER_ORG },
    });

    await consumer.handle(event);

    expect(dispatch.emit).not.toHaveBeenCalled();
    expect(updates.some((u) => u.status === "SKIPPED")).toBe(true);
    expect(updates.some((u) => u.status === "FAILED")).toBe(false);
  });

  it("marks a delivery FAILED and rethrows so the publisher retries then dead-letters", async () => {
    const { db, updates } = buildConsumerDb({ claimOutcome: "NEW" });
    dispatch.emit.mockRejectedValueOnce(new Error("provider down"));
    const consumer = await buildSubmittedConsumer(db);

    await expect(consumer.handle(outboxEvent())).rejects.toThrow("provider down");
    expect(updates.some((u) => u.status === "FAILED")).toBe(true);
  });

  it("maps each decision status onto its catalog event key", async () => {
    for (const status of ["APPROVED", "REJECTED", "PAID"] as const) {
      dispatch.emit.mockClear();
      const { db } = buildConsumerDb({ claimOutcome: "NEW" });
      const consumer = await buildDecidedConsumer(db);
      const event = outboxEvent({
        eventType: EXPENSE_DECIDED_EVENT,
        payload: {
          expenseId: 42,
          orgId: ORG,
          actorUserId: ACTOR,
          recipientUserId: SUBMITTER,
          status,
          amount: "100.00",
          category: "TRAVEL",
          rejectionReason: status === "REJECTED" ? "Missing receipt" : null,
          journalEntryId: null,
        },
      });

      await consumer.handle(event);

      expect(dispatch.emit).toHaveBeenCalledTimes(1);
      expect(dispatch.emit.mock.calls[0]?.[0]?.eventKey).toBe(decisionEventKey(status));
      expect(dispatch.emit.mock.calls[0]?.[0]?.targetUserIds).toEqual([SUBMITTER]);
    }
  });
});

describe("expense outbox — aggregate version", () => {
  it("derives a monotonic per-aggregate version from the outbox, not from the clock", async () => {
    const { db, inserts } = buildWriteDb();
    const service = await buildWriteService(db);

    await service.create(ORG, SUBMITTER, CREATE_INPUT);
    await service.create(ORG, SUBMITTER, CREATE_INPUT);

    const versions = inserts
      .filter((i) => i.table === "outbox_events")
      .map((i) => i.values.aggregateVersion);

    // Two transitions of one expense inside the same millisecond would collide on a
    // timestamp version and roll the business write back on uniq_outbox_events_org_agg_version.
    expect(versions).toEqual([1, 2]);
  });
});

describe("expense side effects are observed", () => {
  // Split-out lib files count as owned expense paths. This scan keys on file
  // name, so code that moves into lib/ leaves the guard's reach unless it is
  // listed here — a silent shrink that looks exactly like a passing gate.
  const OWNED_FILES = [
    "expenses-write.service.ts",
    "expense-lifecycle.service.ts",
    "lib/expense-approval.ts",
    "lib/expense-policy-rules.ts",
    "expenses.service.ts",
    "expenses-import.service.ts",
    "travel.service.ts",
  ];

  it("finds the owned expense service files it claims to scan", () => {
    for (const file of OWNED_FILES) {
      const source = readFileSync(join(__dirname, file), "utf8");
      expect(source.length).toBeGreaterThan(200);
    }
  });

  it("leaves no unobserved fire-and-forget promise in an owned expense path", () => {
    const offenders: string[] = [];
    for (const file of OWNED_FILES) {
      const source = readFileSync(join(__dirname, file), "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        if (/^\s*void\s+this\./.test(line)) offenders.push(`${file}:${index + 1} ${line.trim()}`);
        if (/\.catch\(\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\)/.test(line)) {
          offenders.push(`${file}:${index + 1} ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("reports an offender when one exists", () => {
    const fixture = ["  void this.dispatchSomething(orgId);"];
    const offenders = fixture.filter((line) => /^\s*void\s+this\./.test(line));
    expect(offenders).toHaveLength(1);
  });
});
