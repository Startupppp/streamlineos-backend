import { Logger } from "@nestjs/common";
import { OutboxWriter } from "./outbox-writer";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { OutboxReportService } from "./outbox-report.service";
import { OutboxConsumerRegistry, type OutboxEventRow } from "./outbox-consumer.registry";
import {
  getObservabilityContext,
  runWithObservabilityContext,
} from "../observability/observability-context";
import type { TenantTx } from "../tenant";

const mockForEachOrg = jest.fn();
const mockRunInNewTenantTransaction = jest.fn();

jest.mock("../tenant", () => ({
  forEachOrg: (...args: unknown[]) => mockForEachOrg(...args),
}));

jest.mock("../tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) => mockRunInNewTenantTransaction(...args),
}));

const REQUEST_CORRELATION_ID = "0f6b1e2c-1111-4a2b-8c3d-4e5f60718293";
const EVENT_ID = "3d9c7a1e-2222-4b3c-9d4e-5f6071829304";

function makeRow(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    outboxEventId: 1,
    eventId: EVENT_ID,
    organizationId: "org-1",
    aggregateType: "deal",
    aggregateId: "deal-1",
    aggregateVersion: 1,
    schemaVersion: 1,
    causationId: null,
    correlationId: REQUEST_CORRELATION_ID,
    actorMembershipId: null,
    audience: "INTERNAL",
    lifecycleState: "ACTIVE",
    deliveryState: "PENDING",
    eventType: "deal.closed",
    payload: {},
    occurredAt: new Date("2026-08-25T00:00:00.000Z"),
    publishedAt: null,
    leaseExpiresAt: null,
    retryCount: 0,
    lastError: null,
    deadLetteredAt: null,
    createdAt: new Date("2026-08-25T00:00:00.000Z"),
    ...overrides,
  };
}

function makeTxMock() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return { update, set, where };
}

function makeDb(orgStatus: string | null = "ACTIVE") {
  const limit = jest.fn().mockResolvedValue(orgStatus === null ? [] : [{ status: orgStatus }]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { select, where, limit, from };
}

function forEachOrgWithRow(row: OutboxEventRow) {
  return mockForEachOrg.mockImplementation(
    async (_db: unknown, _sweep: string, fn: (tx: TenantTx, orgId: string) => Promise<void>) => {
      const returning = jest.fn().mockResolvedValue([row]);
      const where = jest.fn().mockReturnValue({ returning });
      const set = jest.fn().mockReturnValue({ where });
      const update = jest.fn().mockReturnValue({ set });
      await fn({ update } as never, row.organizationId);
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  mockRunInNewTenantTransaction.mockImplementation(
    async (db: ReturnType<typeof makeDb>, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ ...makeTxMock(), select: db.select }),
  );
});

describe("OutboxWriter carries the originating intent onto the event", () => {
  function captureInsert() {
    const values = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue({ values });
    return { tx: { insert } as never, values };
  }

  const input = {
    eventId: EVENT_ID,
    organizationId: "org-1",
    aggregateType: "deal",
    aggregateId: "deal-1",
    aggregateVersion: 1,
    eventType: "deal.closed",
    payload: {},
    occurredAt: new Date("2026-08-25T00:00:00.000Z"),
  };

  it("defaults correlation_id to the ambient request id, so no producer has to remember", async () => {
    const { tx, values } = captureInsert();

    await runWithObservabilityContext({ correlationId: REQUEST_CORRELATION_ID }, () =>
      OutboxWriter.emit(tx, input),
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: REQUEST_CORRELATION_ID }),
    );
  });

  it("(bite proof) writes null with no ambient context, which is what every event used to get", async () => {
    const { tx, values } = captureInsert();

    await OutboxWriter.emit(tx, input);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ correlationId: null }));
  });

  it("an explicit correlation id still wins over the ambient one", async () => {
    const explicit = "aaaaaaaa-3333-4bbb-8ccc-dddddddddddd";
    const { tx, values } = captureInsert();

    await runWithObservabilityContext({ correlationId: REQUEST_CORRELATION_ID }, () =>
      OutboxWriter.emit(tx, { ...input, correlationId: explicit }),
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ correlationId: explicit }));
  });

  it("a caller-supplied non-uuid correlation id is dropped rather than written to a uuid column", async () => {
    const { tx, values } = captureInsert();

    await runWithObservabilityContext({ correlationId: "upstream-req-42" }, () =>
      OutboxWriter.emit(tx, input),
    );

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ correlationId: null }));
  });
});

describe("outbox delivery states its tenant rather than inheriting one", () => {
  function serviceWithConsumer(
    row: OutboxEventRow,
    handle: (event: OutboxEventRow) => Promise<void>,
  ) {
    const db = makeDb();
    const registry = new OutboxConsumerRegistry();
    registry.register({ eventType: row.eventType, handle });
    forEachOrgWithRow(row);
    return new OutboxPublisherService(
      db as never,
      { OUTBOX_DISPATCH_ENABLED: "true" } as never,
      registry,
      new OutboxReportService(db as never),
    );
  }

  it("a consumer runs with the producing request's correlation id and the event's organisation", async () => {
    const row = makeRow();
    let seen: ReturnType<typeof getObservabilityContext>;
    const service = serviceWithConsumer(row, async () => {
      seen = getObservabilityContext();
    });

    const result = await service.flush();

    expect(result.delivered).toBe(1);
    expect(seen).toMatchObject({
      correlationId: REQUEST_CORRELATION_ID,
      orgId: "org-1",
      route: "outbox:deal.closed",
    });
  });

  it("the publisher never inherits an ambient context — a legacy row gets its own id, not the caller's", async () => {
    const row = makeRow({ correlationId: null });
    let seen: ReturnType<typeof getObservabilityContext>;
    const service = serviceWithConsumer(row, async () => {
      seen = getObservabilityContext();
    });

    const flusherId = "ffffffff-4444-4eee-8fff-999999999999";
    await runWithObservabilityContext({ correlationId: flusherId, orgId: "org-someone-else" }, () =>
      service.flush(),
    );

    expect(seen?.correlationId).not.toBe(flusherId);
    expect(seen?.orgId).toBe("org-1");
  });

  it("a failing consumer's stored last_error carries no bind values", async () => {
    const row = makeRow();
    const service = serviceWithConsumer(row, async () => {
      throw new Error(
        'Failed query: insert into "deals" ("owner_email") values ($1)\nparams: ada@lovelace.example',
      );
    });

    const captured: unknown[] = [];
    mockRunInNewTenantTransaction.mockImplementation(
      async (db: ReturnType<typeof makeDb>, _orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
        const tx = makeTxMock();
        tx.set.mockImplementation((patch: unknown) => {
          captured.push(patch);
          return { where: tx.where };
        });
        return fn({ ...tx, select: db.select });
      },
    );

    const result = await service.flush();

    expect(result.retried).toBe(1);
    const errors = captured
      .map((patch) => (patch as { lastError?: unknown }).lastError)
      .filter((value): value is string => typeof value === "string");
    expect(errors.length).toBeGreaterThan(0);
    for (const message of errors) {
      expect(message).not.toContain("ada@lovelace.example");
      expect(message).toContain("deals");
    }
  });
});
