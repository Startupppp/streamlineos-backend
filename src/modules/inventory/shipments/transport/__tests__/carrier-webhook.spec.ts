/**
 * INV-26 — the inbound half: a courier telling us where a parcel got to.
 *
 * ## What stands in for the database, and what that costs
 *
 * An in-memory store whose one non-trivial behaviour is the unique key on
 * `(org_id, carrier_id, event_key)` — because that key IS the idempotency
 * mechanism, and a double that ignored it would let the redelivery case pass
 * while the real receiver double-applied every retry. So the fake enforces it,
 * and it enforces nothing else it was not asked to.
 *
 * It is still a double, and the honest limit is worth stating: it proves the
 * receiver *asks* for the conflict, not that Postgres *has* the index. The
 * index itself is created by migration 1099 and is verified by the cold build,
 * which is the only thing that can verify it.
 *
 * The tenant transaction is stubbed to run its callback inline. The receiver
 * uses it to open a GUC-carrying transaction on a public route where there is
 * no ambient request context; that is a property of the connection, not of the
 * logic under test, and `run-in-tenant-transaction` has its own coverage.
 */

jest.mock("../../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: <T,>(_db: unknown, fn: () => Promise<T>): Promise<T> => fn(),
}));

import { createHash } from "node:crypto";
import {
  invAuditEvents,
  invCarriers,
  invCarrierWebhookDeliveries,
  invShipments,
  invShipmentStatusEvents,
} from "../../../../../db/schema";
import type { Db } from "../../../../../db/drizzle.module";
import { encryptSecret } from "../../../../../common/security/secret-encryption.util";
import { webhookSignatureHeaderValue } from "../../../webhooks/webhook-signature";
import { InventoryAuditService } from "../../../stock-engine/inventory-audit.service";
import { CarrierWebhookReceiverService } from "../carrier-webhook.service";
import { CarrierTransportRegistry } from "../carrier-transport.registry";
import { ReferenceHttpCarrierAdapter } from "../reference-http.adapter";

const SECRET = "carrier-webhook-shared-secret-at-least-32";
const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "carrier-webhook-spec-key";
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

interface Row {
  [column: string]: unknown;
}

interface Store {
  carriers: Row[];
  shipments: Row[];
  deliveries: Row[];
  statusEvents: Row[];
  audits: Row[];
  carrierUpdates: Row[];
  shipmentUpdates: Row[];
}

function freshStore(overrides: Partial<Store> = {}): Store {
  return {
    carriers: [
      {
        id: 7,
        code: "STUBX",
        transport: "reference-http",
        apiBaseUrl: "https://carrier.example.com",
        apiCredentialEncrypted: encryptSecret("sandbox-key"),
        webhookSecretEncrypted: encryptSecret(SECRET),
      },
    ],
    shipments: [{ id: 42, status: "SHIPPED", carrierId: 7 }],
    deliveries: [],
    statusEvents: [],
    audits: [],
    carrierUpdates: [],
    shipmentUpdates: [],
    ...overrides,
  };
}

/** An awaitable insert builder that also answers the two chained forms. */
function insertResult(rows: Row[]) {
  const settled = Promise.resolve(rows);
  return {
    onConflictDoNothing: () => ({ returning: () => Promise.resolve(rows) }),
    returning: () => Promise.resolve(rows),
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  };
}

/**
 * The store, wearing just enough of Drizzle's shape.
 *
 * Dispatch is on the table object's identity, so a query against a table this
 * fake does not know throws rather than silently answering nothing — the
 * failure mode where a double invents a callee and a dead branch reads as live.
 */
function fakeDb(store: Store) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            if (table === invCarriers) return Promise.resolve(store.carriers);
            if (table === invShipments) return Promise.resolve(store.shipments);
            throw new Error("fakeDb: unexpected select target");
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => {
        if (table === invCarrierWebhookDeliveries) {
          // The unique key, modelled: a second row for the same event inserts
          // nothing, which is what `ON CONFLICT DO NOTHING` returns.
          const clash = store.deliveries.some(
            (row) =>
              row.orgId === values.orgId &&
              row.carrierId === values.carrierId &&
              row.eventKey === values.eventKey,
          );
          if (clash) return insertResult([]);
          store.deliveries.push(values);
          return insertResult([{ id: store.deliveries.length }]);
        }
        if (table === invShipmentStatusEvents) {
          const clash = store.statusEvents.some(
            (row) =>
              row.orgId === values.orgId &&
              row.carrierId === values.carrierId &&
              row.carrierEventId != null &&
              row.carrierEventId === values.carrierEventId,
          );
          if (clash) return insertResult([]);
          store.statusEvents.push(values);
          return insertResult([{ id: store.statusEvents.length }]);
        }
        if (table === invAuditEvents) {
          store.audits.push(values);
          return insertResult([{ id: store.audits.length }]);
        }
        throw new Error("fakeDb: unexpected insert target");
      },
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          if (table === invCarriers) store.carrierUpdates.push(values);
          else if (table === invShipments) store.shipmentUpdates.push(values);
          else throw new Error("fakeDb: unexpected update target");
          return Promise.resolve([]);
        },
      }),
    }),
  };
}

/**
 * The one forced type in this file, and the only place a cast appears.
 *
 * The fake implements the query-builder surface the receiver and `applyEvent`
 * actually use. Drizzle's `Db` is a structural type of enormous width, so no
 * partial object can satisfy it by inference; this is the mocking seam, not a
 * silenced type error.
 */
function asDb(store: Store): Db {
  return fakeDb(store) as unknown as Db;
}

function signed(body: string, secret = SECRET): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return { "x-inventory-signature": webhookSignatureHeaderValue(secret, timestamp, body) };
}

function callback(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: "evt-1",
    trackingNumber: "STUBX-000123",
    status: "DELIVERED",
    occurredAt: "2026-09-12T09:30:00.000Z",
    ...overrides,
  });
}

function receiverFor(store: Store): CarrierWebhookReceiverService {
  const registry = new CarrierTransportRegistry(new ReferenceHttpCarrierAdapter());
  return new CarrierWebhookReceiverService(asDb(store), new InventoryAuditService(), registry);
}

describe("carrier webhook ingest", () => {
  it("applies a verified callback and moves the shipment forward", async () => {
    const store = freshStore();
    const body = callback();

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body),
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, applied: true, status: "DELIVERED" });
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({ status: "applied", shipmentId: 42 });
    expect(store.shipmentUpdates[0]).toMatchObject({ status: "DELIVERED" });
    // Nobody did this, so the audit row names nobody rather than inventing an
    // actor — `actor_user_id` is a nullable FK and "" would violate it.
    expect(store.audits[0]).toMatchObject({ actorUserId: null });
  });

  it("refuses an unverified callback and opens no row", async () => {
    const store = freshStore();
    const body = callback();

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body, "a-different-secret-that-is-long-enough"),
    });

    expect(result.status).toBe(401);
    // The point of the rule: a public URL plus a forged signature must not be
    // able to write a row, or the ingest is an unbounded write for anyone.
    expect(store.deliveries).toHaveLength(0);
    expect(store.statusEvents).toHaveLength(0);
    // It is still visible — bounded at two columns on the carrier that exists.
    expect(store.carrierUpdates[0]).toMatchObject({ webhookFailureReason: "signature-mismatch" });
  });

  it("refuses a callback whose body was altered after signing", async () => {
    const store = freshStore();
    const body = callback();
    const headers = signed(body);

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body.replace("DELIVERED", "CANCELLED"),
      headers,
    });

    expect(result.status).toBe(401);
    expect(store.deliveries).toHaveLength(0);
  });

  it("applies a redelivered callback exactly once", async () => {
    const store = freshStore();
    const body = callback();
    const headers = signed(body);
    const receiver = receiverFor(store);

    const first = await receiver.receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers,
    });
    const second = await receiver.receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers,
    });

    expect(first.body).toEqual({ ok: true, applied: true, status: "DELIVERED" });
    // 200 with `duplicate`, not an error: a redelivery is a courier behaving
    // correctly, and answering 4xx would make it keep trying.
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: true });
    expect(store.deliveries).toHaveLength(1);
    expect(store.statusEvents).toHaveLength(1);
    expect(store.shipmentUpdates).toHaveLength(1);
  });

  it("dead-letters a callback for a tracking number this tenant does not hold", async () => {
    const store = freshStore({ shipments: [] });
    const body = callback({ trackingNumber: "SOMEONE-ELSES-999" });

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body),
    });

    // 202: the callback was genuine and has been kept. A 4xx would make the
    // courier retry something that fails identically every time.
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ ok: true, deadLettered: true });
    expect(store.deliveries[0]).toMatchObject({
      status: "dead_lettered",
      shipmentId: null,
      trackingNumber: "SOMEONE-ELSES-999",
    });
    expect(store.deliveries[0]?.reason).toContain("SOMEONE-ELSES-999");
    expect(store.statusEvents).toHaveLength(0);
  });

  it("dead-letters a verified callback it cannot read, keyed on the signed body", async () => {
    const store = freshStore();
    const body = JSON.stringify({ somethingElse: true });

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body),
    });

    expect(result.status).toBe(202);
    expect(store.deliveries[0]).toMatchObject({
      status: "dead_lettered",
      eventKey: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("answers the same 404 for an unknown carrier and an unknown organisation", async () => {
    const store = freshStore({ carriers: [] });
    const body = callback();

    const result = await receiverFor(store).receive({
      orgId: "org-nobody",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body),
    });

    // An unauthenticated caller must not be able to enumerate either.
    expect(result).toEqual({ status: 404, body: { ok: false, error: "carrier not configured" } });
  });

  it("refuses to verify anything when no webhook secret is installed", async () => {
    const store = freshStore();
    store.carriers[0] = { ...store.carriers[0], webhookSecretEncrypted: null };
    const body = callback();

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body),
    });

    // Not "accept it because there is nothing to check against".
    expect(result).toEqual({ status: 400, body: { ok: false, error: "webhook not configured" } });
    expect(store.deliveries).toHaveLength(0);
  });

  it("refuses a carrier that names no transport, rather than guessing one", async () => {
    const store = freshStore();
    store.carriers[0] = { ...store.carriers[0], transport: null };
    const body = callback();

    const result = await receiverFor(store).receive({
      orgId: "org-1",
      carrierCode: "STUBX",
      rawBody: body,
      headers: signed(body),
    });

    expect(result).toEqual({ status: 400, body: { ok: false, error: "carrier has no transport" } });
  });
});
