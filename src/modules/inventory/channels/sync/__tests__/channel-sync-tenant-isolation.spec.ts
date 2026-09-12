/**
 * INV-27 — cross-tenant isolation for the channel-sync seam.
 *
 * ## What this file is for
 *
 * `check:tenant-isolation` named `ChannelSyncService` as a tenant-owned service
 * with no cross-tenant negative test. The sibling specs in this folder cover the
 * worker (`channel-sync.worker.spec.ts`) and the Shopify adapter; neither is
 * about tenancy, and the service is the only place a request-supplied
 * `channelId` or `jobId` is turned into a row.
 *
 * ## What is actually at stake here
 *
 * Every operator-facing method on this service takes an id straight off the URL.
 * `assertChannel` is the single object-level check standing between that id and
 * a durable job row, and `retry` has no separate check at all — its scoping is
 * inside the `UPDATE` predicate, which is why the retry case below reads the
 * predicate rather than only the refusal. A missing `eq(orgId)` on either path
 * would let one tenant push another tenant's stock to a marketplace, which is a
 * correctness failure visible to that tenant's customers, not just a leak.
 *
 * ## The two halves
 *
 * DENY is the behaviour: a foreign id must raise `NotFoundException` — 404, not
 * 403, because a 403 on another org's id confirms the record exists
 * (backend/CLAUDE.md §4) — and must enqueue nothing.
 *
 * CONTROL is the mechanism: it reads the predicate the service handed Drizzle
 * and asserts the caller's `orgId` is bound into it. Without it, a service that
 * had lost its org predicate entirely would still pass DENY, because a double
 * that answers nothing answers nothing for every reason.
 */

// `requeue` opens its own tenant transaction so a marketplace call never holds a
// pooled connection. That is a property of the connection, not of the tenancy
// logic under test, and `run-in-tenant-transaction` has its own coverage — so it
// runs its callback against the same fake handle here.
jest.mock("../../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  runInNewTenantTransaction: <T,>(
    db: unknown,
    _orgId: string,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> => fn(db),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../../db/drizzle.module";
import { NumberSequenceService } from "../../../stock-engine/number-sequence.service";
import { ChannelCommerceRegistry } from "../channel-commerce.port";
import { ChannelSyncService } from "../channel-sync.service";

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

/** Every bound value in a Drizzle expression tree, flattened. */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

type Harness = {
  service: ChannelSyncService;
  findFirst: jest.Mock;
  updateWhere: jest.Mock;
  inserts: unknown[];
};

/**
 * @param channel  what `invChannels.findFirst` answers — `undefined` models the
 *                 foreign tenant, whose rows this caller can never see.
 * @param requeued what the retry UPDATE returns.
 */
function harness(channel: unknown, requeued: unknown[] = []): Harness {
  const findFirst = jest.fn().mockResolvedValue(channel);
  const inserts: unknown[] = [];
  const updateWhere = jest.fn();

  // Declared before it is populated: every builder method answers the builder
  // itself, which an inferred object literal cannot express (TS7022).
  const updateChain = {} as {
    set: jest.Mock;
    where: jest.Mock;
    returning: jest.Mock;
  };
  updateChain.set = jest.fn(() => updateChain);
  updateChain.where = updateWhere;
  updateChain.returning = jest.fn().mockResolvedValue(requeued);
  updateWhere.mockReturnValue(updateChain);

  const insertChain = {} as {
    values: jest.Mock;
    onConflictDoNothing: jest.Mock;
    returning: jest.Mock;
  };
  insertChain.values = jest.fn((values: unknown) => {
    inserts.push(values);
    return insertChain;
  });
  insertChain.onConflictDoNothing = jest.fn(() => insertChain);
  insertChain.returning = jest.fn().mockResolvedValue([]);

  const db = {
    query: { invChannels: { findFirst } },
    update: jest.fn(() => updateChain),
    insert: jest.fn(() => insertChain),
    select: jest.fn(),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;

  const service = new ChannelSyncService(
    db,
    new NumberSequenceService(db),
    new ChannelCommerceRegistry(),
  );
  return { service, findFirst, updateWhere, inserts };
}

const FOREIGN_CHANNEL = 9;
const SHIP_CONFIRM = {
  externalOrderId: "ext-1",
  salesOrderId: 1,
  trackingNumber: "TRK-1",
  carrierName: "STUBX",
  trackingUrl: null,
  lines: [],
};

describe("ChannelSyncService — cross-tenant isolation", () => {
  describe("a channel id belonging to another organisation", () => {
    // Every entry point that takes a channel id off the URL. Enumerated rather
    // than sampled: a new one added without `assertChannel` is precisely the
    // regression this file exists to catch, and one representative method would
    // not see it.
    const calls: readonly [string, (service: ChannelSyncService) => Promise<unknown>][] = [
      ["enqueueStockSync", (s) => s.enqueueStockSync(ATTACKER, "actor-1", FOREIGN_CHANNEL)],
      ["enqueueOrderPull", (s) => s.enqueueOrderPull(ATTACKER, "actor-1", FOREIGN_CHANNEL, undefined)],
      [
        "enqueueShipConfirm",
        (s) => s.enqueueShipConfirm(ATTACKER, "actor-1", FOREIGN_CHANNEL, SHIP_CONFIRM as never),
      ],
      [
        "listFailures",
        (s) => s.listFailures(ATTACKER, FOREIGN_CHANNEL, { page: 1, limit: 20 } as never),
      ],
    ];

    it.each(calls)("404s from %s and enqueues nothing (DENY — cross-tenant isolation)", async (_name, call) => {
      const { service, inserts } = harness(undefined);
      await expect(call(service)).rejects.toBeInstanceOf(NotFoundException);
      // The refusal has to happen before the job row: a queued STOCK_PUSH would
      // reach the marketplace on the next drain, long after the request is gone.
      expect(inserts).toHaveLength(0);
    });
  });

  it("binds the caller's org into the channel lookup (CONTROL)", async () => {
    const { service, findFirst } = harness({ id: FOREIGN_CHANNEL, channelType: "SHOPIFY" });

    await service.enqueueStockSync(OWNER, "actor-1", FOREIGN_CHANNEL).catch(() => undefined);

    expect(findFirst).toHaveBeenCalled();
    const where = (findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    expect(sqlValues(where)).toContain(OWNER);
  });

  describe("retry", () => {
    it("404s on another organisation's job id (DENY — cross-tenant isolation)", async () => {
      // The UPDATE matched no row, which is what a foreign `org_id` produces.
      const { service } = harness(undefined, []);
      await expect(service.retry(ATTACKER, 123)).rejects.toBeInstanceOf(NotFoundException);
    });

    it("binds the caller's org into the requeue predicate (CONTROL)", async () => {
      // retry() has no assertChannel in front of it — the org scoping lives
      // entirely inside this predicate, so this assertion is the only thing
      // standing between a guessed job id and another tenant's dead letter.
      const { service, updateWhere } = harness(undefined, [{ id: 123 }]);

      await expect(service.retry(OWNER, 123)).resolves.toEqual({ retried: true, jobId: 123 });

      expect(updateWhere).toHaveBeenCalled();
      expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(OWNER);
    });
  });
});
