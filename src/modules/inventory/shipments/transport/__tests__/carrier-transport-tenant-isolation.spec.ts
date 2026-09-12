/**
 * INV-26 — cross-tenant isolation for the three carrier-transport services.
 *
 * ## What this file is for
 *
 * `check:tenant-isolation` enumerates every service holding a Drizzle handle
 * that filters on `orgId`, and named these three as having no cross-tenant
 * negative test: `CarrierCredentialsService`, `CarrierTransportService` and
 * `CarrierWebhookReceiverService`. The production code was already scoped — the
 * gap was the test, and a scoping rule with no test is one careless edit from
 * being untrue. The sibling `carrier-webhook.spec.ts` covers signature
 * verification and idempotency; none of its cases is about tenancy.
 *
 * ## The two halves, and why both are needed
 *
 * DENY is the behaviour: with the foreign tenant's rows invisible (the database
 * answers nothing for `org_id = <attacker>`), the service must refuse — 404 and
 * never 403, because a 403 on another org's id confirms the record exists
 * (backend/CLAUDE.md §4) — and must not go on to write anything.
 *
 * CONTROL is the mechanism: it reads back the predicate the service actually
 * handed Drizzle and asserts the caller's `orgId` is bound into it. Without this
 * half, a service that had dropped its `eq(orgId)` entirely would still pass the
 * DENY case, because a double that returns nothing returns nothing for every
 * reason. That is the failure shape where a spec agrees with the bug.
 *
 * `sqlValues` is what makes the CONTROL half possible: a Drizzle `and(eq(...))`
 * is a tree of `queryChunks` with bound `value`s at the leaves, so flattening
 * the tree and looking for the org id is the only way to see the binding without
 * running a database.
 */

// `receive` opens a GUC-carrying transaction because the webhook route is
// public and has no ambient request context. That is a property of the
// connection, not of the tenancy logic under test, and the real helper has its
// own coverage — so it runs its callback inline here, exactly as the sibling
// carrier-webhook.spec.ts does.
jest.mock("../../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../../db/drizzle.module";
import { InventoryAuditService } from "../../../stock-engine/inventory-audit.service";
import { CarrierCredentialsService } from "../carrier-credentials.service";
import { CarrierTransportRegistry } from "../carrier-transport.registry";
import { CarrierTransportService } from "../carrier-transport.service";
import { CarrierWebhookReceiverService } from "../carrier-webhook.service";
import { ReferenceHttpCarrierAdapter } from "../reference-http.adapter";

const ATTACKER = "org-attacker";
const OWNER = "org-owner";

/**
 * Every bound value in a Drizzle expression tree, flattened.
 *
 * Cycles are possible in a column reference (a column knows its table and the
 * table knows its columns), so visited objects are remembered.
 */
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

type Chain = {
  from: jest.Mock;
  leftJoin: jest.Mock;
  innerJoin: jest.Mock;
  where: jest.Mock;
  limit: jest.Mock;
  orderBy: jest.Mock;
  set: jest.Mock;
  values: jest.Mock;
  returning: jest.Mock;
  onConflictDoNothing: jest.Mock;
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
};

/**
 * A Drizzle-shaped builder that is also a thenable, so `await` at any point in
 * the chain resolves to `rows` no matter which methods were called first.
 */
function makeChain(rows: unknown[]): Chain {
  const chain = {} as Chain;
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  for (const method of [
    "from",
    "leftJoin",
    "innerJoin",
    "where",
    "limit",
    "orderBy",
    "set",
    "values",
    "returning",
    "onConflictDoNothing",
  ] as const)
    chain[method] = jest.fn().mockReturnValue(chain);
  return chain;
}

type Harness = {
  db: Db;
  chain: Chain;
  inserts: unknown[];
  updates: unknown[];
};

/** Reads answer `rows`; writes are recorded rather than performed. */
function makeDb(rows: unknown[]): Harness {
  const chain = makeChain(rows);
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const insertChain = makeChain([]);
  insertChain.values = jest.fn((values: unknown) => {
    inserts.push(values);
    return insertChain;
  });
  const updateChain = makeChain([]);
  updateChain.set = jest.fn((values: unknown) => {
    updates.push(values);
    return updateChain;
  });
  const db = {
    select: jest.fn().mockReturnValue(chain),
    insert: jest.fn().mockReturnValue(insertChain),
    update: jest.fn().mockReturnValue(updateChain),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
  return { db, chain, inserts, updates };
}

function registry(): CarrierTransportRegistry {
  return new CarrierTransportRegistry(new ReferenceHttpCarrierAdapter());
}

/** The org id bound into the first `where` the service issued. */
function firstWhereValues(chain: Chain): unknown[] {
  expect(chain.where).toHaveBeenCalled();
  return sqlValues(chain.where.mock.calls[0]?.[0]);
}

// ─── CarrierCredentialsService ────────────────────────────────────────────────

describe("CarrierCredentialsService — cross-tenant isolation", () => {
  const cache = { invalidate: jest.fn(), get: jest.fn(), set: jest.fn() };

  it("404s on another org's carrier id rather than installing credentials (DENY — cross-tenant isolation)", async () => {
    const { db, inserts, updates } = makeDb([]);
    const service = new CarrierCredentialsService(db, cache as never, new InventoryAuditService(), registry());

    await expect(
      service.setCredentials(ATTACKER, "actor-1", 7, { apiCredential: "stolen-key" } as never),
    ).rejects.toBeInstanceOf(NotFoundException);

    // A refusal that still wrote would be worse than no refusal: the point of
    // 404 here is that the attacker learns nothing and changes nothing.
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("binds the caller's org into the carrier lookup (CONTROL)", async () => {
    const { db, chain } = makeDb([{ id: 7, apiCredentialHint: null, webhookSecretEncrypted: null }]);
    const service = new CarrierCredentialsService(db, cache as never, new InventoryAuditService(), registry());

    await service
      .setCredentials(OWNER, "actor-1", 7, { apiCredential: "owner-key" } as never)
      .catch(() => undefined);

    expect(firstWhereValues(chain)).toContain(OWNER);
  });
});

// ─── CarrierTransportService ──────────────────────────────────────────────────

describe("CarrierTransportService — cross-tenant isolation", () => {
  function service(db: Db): CarrierTransportService {
    return new CarrierTransportService(db, new InventoryAuditService(), registry());
  }

  it.each(["book", "fetchLabel", "track"] as const)(
    "404s on another org's shipment id from %s (DENY — cross-tenant isolation)",
    async (operation) => {
      const { db, inserts, updates } = makeDb([]);

      await expect(service(db)[operation](ATTACKER, "actor-1", 42)).rejects.toBeInstanceOf(
        NotFoundException,
      );

      // No carrier was called and no operation row was opened, so a probe
      // cannot be told from a shipment id that does not exist at all.
      expect(inserts).toHaveLength(0);
      expect(updates).toHaveLength(0);
    },
  );

  it("binds the caller's org into the shipment lookup (CONTROL)", async () => {
    const { db, chain } = makeDb([{ id: 42, shipmentNumber: "SH-1", carrierRowId: null, carrierCode: null }]);

    await service(db)
      .book(OWNER, "actor-1", 42)
      .catch(() => undefined);

    expect(firstWhereValues(chain)).toContain(OWNER);
  });
});

// ─── CarrierWebhookReceiverService ────────────────────────────────────────────

describe("CarrierWebhookReceiverService — cross-tenant isolation", () => {
  function receiver(db: Db): CarrierWebhookReceiverService {
    return new CarrierWebhookReceiverService(db, new InventoryAuditService(), registry());
  }

  it("answers 404 for a carrier code that belongs to another organisation (DENY — cross-tenant isolation)", async () => {
    const { db, inserts, updates } = makeDb([]);

    const result = await receiver(db).receive({
      orgId: ATTACKER,
      carrierCode: "STUBX",
      rawBody: JSON.stringify({ eventId: "evt-1" }),
      headers: {},
    });

    // The route is public and unauthenticated, so the answer for "no such
    // organisation" and "no such carrier" has to be the same one: anything else
    // lets an anonymous caller enumerate tenants by carrier code.
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ ok: false, error: "carrier not configured" });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("binds the posting organisation into the carrier lookup (CONTROL)", async () => {
    const { db, chain } = makeDb([{ id: 7, code: "STUBX", transport: null }]);

    await receiver(db).receive({
      orgId: OWNER,
      carrierCode: "STUBX",
      rawBody: JSON.stringify({ eventId: "evt-1" }),
      headers: {},
    });

    expect(firstWhereValues(chain)).toContain(OWNER);
    expect(firstWhereValues(chain)).toContain("STUBX");
  });
});
