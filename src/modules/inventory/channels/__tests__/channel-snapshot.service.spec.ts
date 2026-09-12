import { BadRequestException, ConflictException } from "@nestjs/common";
import { ChannelSnapshotService } from "../channel-snapshot.service";
import { planSnapshotDifferences } from "../snapshot-difference";
import { signChannelPayload, type ChannelSnapshotResult } from "../channel-adapter";

/**
 * E6 — snapshot → refetch → idempotent command, against fakes that encode the
 * failure modes a real marketplace produces.
 *
 * The four modes, and where each is answered:
 *
 *   timeout                the adapter never answers  → `channel-adapter.spec.ts`
 *                          (the deadline) and the retry ladder there
 *   duplicate delivery     the channel resends        → "a duplicate delivery
 *                          enqueues nothing", below
 *   partial success        some SKUs answered         → `planSnapshotDifferences`
 *                          records the answered ones and invents nothing for the
 *                          rest, below
 *   200 with an error body a "successful" empty list  → the same rule, below,
 *                          which is where it would otherwise become "the channel
 *                          says zero" for every SKU we publish
 *
 * The database is faked at the smallest surface the code under test uses. That
 * is a real limit and worth stating: these assert the *decisions*, not that the
 * SQL is right. What makes the SQL right is in the migration — a unique
 * `(org, channel, provider_delivery_id)` and a partial unique index on OPEN
 * differences — and the tests below assert the code relies on them rather than
 * on a read-then-write it could lose a race on.
 */

const ORG = "org-1";
const USER = "u-1";
const SECRET = "deployment-secret";

/* ------------------------------------------------------------------ *
 * The rule: "no answer" is never "zero"
 * ------------------------------------------------------------------ */

function okSnapshot(
  items: Array<{ sku: string; quantity: string }>,
  complete = true,
): Extract<ChannelSnapshotResult, { ok: true }> {
  return { ok: true, complete, capturedAt: new Date("2026-08-29T10:00:00Z"), items, failures: [] };
}

describe("E6 — what a snapshot is allowed to mean", () => {
  const skuToVariant = new Map([
    ["SKU-A", 1],
    ["SKU-B", 2],
    ["SKU-C", 3],
  ]);
  const internal = new Map([
    [1, "10.0000"],
    [2, "5.0000"],
    [3, "0.0000"],
  ]);

  it("records a difference only where the channel and the ledger disagree", () => {
    const planned = planSnapshotDifferences({
      snapshot: okSnapshot([
        { sku: "SKU-A", quantity: "7.0000" },
        { sku: "SKU-B", quantity: "5.0000" },
      ]),
      skuToVariant,
      internalAvailability: internal,
    });

    expect(planned).toEqual([
      {
        externalSku: "SKU-A",
        productVariantId: 1,
        channelQty: "7.0000",
        internalQty: "10.0000",
        difference: "-3.0000",
      },
    ]);
  });

  it("invents nothing for a SKU the channel did not mention", () => {
    // The 200-with-an-error-body mode, in its purest form: the adapter reports
    // success and lists nothing. If "did not mention" collapsed into "has zero",
    // every published SKU would acquire a difference of `0 − whatever we hold` —
    // and under ALLOW_ADJUSTMENT that is one request away from writing a
    // warehouse down to nothing.
    expect(
      planSnapshotDifferences({
        snapshot: okSnapshot([]),
        skuToVariant,
        internalAvailability: internal,
      }),
    ).toEqual([]);
  });

  it("records the SKUs a partial listing did answer, and only those", () => {
    // The partial-success mode. The rows that came back are facts and are
    // recorded; the two the channel refused on are not turned into zeroes. The
    // delivery is separately left retryable, which is asserted below.
    const planned = planSnapshotDifferences({
      snapshot: okSnapshot([{ sku: "SKU-A", quantity: "4.0000" }], false),
      skuToVariant,
      internalAvailability: internal,
    });

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ externalSku: "SKU-A", difference: "-6.0000" });
  });

  it("keeps a channel SKU that matches nothing of ours, rather than dropping it", () => {
    // "The channel is selling something we do not stock" is the most useful
    // thing this table says, and a silent drop is how it stops saying it.
    const planned = planSnapshotDifferences({
      snapshot: okSnapshot([{ sku: "SKU-UNKNOWN", quantity: "3.0000" }]),
      skuToVariant,
      internalAvailability: internal,
    });

    expect(planned).toEqual([
      {
        externalSku: "SKU-UNKNOWN",
        productVariantId: null,
        channelQty: "3.0000",
        internalQty: "0.0000",
        difference: "3.0000",
      },
    ]);
  });

  it("reports a matched SKU we hold none of, because that is a real disagreement", () => {
    const planned = planSnapshotDifferences({
      snapshot: okSnapshot([{ sku: "SKU-C", quantity: "2.0000" }]),
      skuToVariant,
      internalAvailability: internal,
    });
    expect(planned).toEqual([
      {
        externalSku: "SKU-C",
        productVariantId: 3,
        channelQty: "2.0000",
        internalQty: "0.0000",
        difference: "2.0000",
      },
    ]);
  });

  it("keeps quantities as decimal strings end to end", () => {
    // A quantity that becomes a float on its way through a reconciliation is how
    // 0.1 + 0.2 ends up as a difference nobody can explain.
    const planned = planSnapshotDifferences({
      snapshot: okSnapshot([{ sku: "SKU-A", quantity: "10.3000" }]),
      skuToVariant,
      internalAvailability: new Map([[1, "10.1000"]]),
    });
    expect(planned[0]!.difference).toBe("0.2000");
  });
});

/* ------------------------------------------------------------------ *
 * Receiving a delivery
 * ------------------------------------------------------------------ */

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (
    _db: unknown,
    fn: (tx: unknown) => Promise<unknown>,
    explicit?: { orgId: string },
  ) => {
    if (!explicit?.orgId) throw new Error("receiveDelivery must pass an explicit orgId");
    return fn((globalThis as { __tx?: unknown }).__tx);
  },
  runInNewTenantTransaction: (_db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn((globalThis as { __tx?: unknown }).__tx),
}));

jest.mock("../../../../common/tenant", () => ({
  forEachOrg: jest.fn(),
}));

interface InsertedDelivery {
  readonly orgId: string;
  readonly channelId: number;
  readonly providerDeliveryId: string;
  readonly payloadDigest: string;
  readonly deliveryMetadata?: Record<string, string>;
}

/**
 * A fake of the delivery table that enforces the one constraint the design
 * leans on: `(org, channel, provider_delivery_id)` is unique. A conflicting
 * insert returns no rows, exactly as `onConflictDoNothing().returning()` does.
 */
function makeDeliveryDb(channel: { id: number; channelType: string; status?: string } | null) {
  const inserted: InsertedDelivery[] = [];
  let nextId = 100;

  const tx = {
    query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
    insert: jest.fn().mockReturnValue({
      values: (row: InsertedDelivery) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const clash = inserted.some(
              (existing) =>
                existing.orgId === row.orgId &&
                existing.channelId === row.channelId &&
                existing.providerDeliveryId === row.providerDeliveryId,
            );
            if (clash) return Promise.resolve([]);
            inserted.push(row);
            nextId += 1;
            return Promise.resolve([{ id: nextId }]);
          },
        }),
      }),
    }),
    select: jest.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: nextId }]) }) }),
    }),
  };

  (globalThis as { __tx?: unknown }).__tx = tx;

  const db = {
    execute: jest.fn().mockResolvedValue([{ org_id: channel ? ORG : null }]),
  };

  return { db, tx, inserted };
}

function makeService(db: unknown, extra: Partial<{ stockEngine: unknown; adapters: unknown }> = {}) {
  return new ChannelSnapshotService(
    db as never,
    {
      INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY: SECRET,
      INV_CHANNEL_WEBHOOK_SECRET_WOOCOMMERCE: undefined,
      INV_CHANNEL_WEBHOOK_SECRET_DEFAULT: undefined,
    } as never,
    (extra.adapters ?? { forChannelType: () => ({ canFetch: false }) }) as never,
    (extra.stockEngine ?? { execute: jest.fn() }) as never,
    { insert: jest.fn().mockResolvedValue(undefined) } as never,
  );
}

const BODY = '{"sku":"SKU-A","available":7}';

function headersFor(deliveryId: string, body = BODY) {
  return {
    "x-shopify-hmac-sha256": signChannelPayload(SECRET, body),
    "x-shopify-webhook-id": deliveryId,
    "x-shopify-topic": "inventory_levels/update",
    "x-shopify-shop-domain": "example.myshopify.com",
  };
}

describe("E6 — receiving a channel delivery", () => {
  it("accepts a correctly signed delivery and records it once", async () => {
    const { db, inserted } = makeDeliveryDb({ id: 5, channelType: "SHOPIFY" });
    const service = makeService(db);

    const outcome = await service.receiveDelivery({
      channelId: 5,
      rawBody: BODY,
      headers: headersFor("delivery-1"),
    });

    expect(outcome).toMatchObject({ accepted: true, duplicate: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.providerDeliveryId).toBe("delivery-1");
  });

  it("a duplicate delivery enqueues nothing", async () => {
    // E6's done-when. A marketplace's delivery guarantee is at-least-once, so
    // this is the ordinary case rather than an attack: the same delivery id
    // arrives twice and the unique index absorbs the second. Nothing is
    // enqueued, so nothing downstream — refetch, difference, or eventual
    // movement — can happen twice.
    const { db, inserted } = makeDeliveryDb({ id: 5, channelType: "SHOPIFY" });
    const service = makeService(db);

    const first = await service.receiveDelivery({
      channelId: 5,
      rawBody: BODY,
      headers: headersFor("delivery-1"),
    });
    const second = await service.receiveDelivery({
      channelId: 5,
      rawBody: BODY,
      headers: headersFor("delivery-1"),
    });

    expect(first).toMatchObject({ accepted: true, duplicate: false });
    // Accepted, not rejected: a channel retrying a delivery it already sent has
    // done nothing wrong, and 4xx would make it retry harder.
    expect(second).toMatchObject({ accepted: true, duplicate: true });
    expect(inserted).toHaveLength(1);
  });

  it("records a second, genuinely different delivery", async () => {
    const { db, inserted } = makeDeliveryDb({ id: 5, channelType: "SHOPIFY" });
    const service = makeService(db);

    await service.receiveDelivery({ channelId: 5, rawBody: BODY, headers: headersFor("d-1") });
    await service.receiveDelivery({ channelId: 5, rawBody: BODY, headers: headersFor("d-2") });

    expect(inserted).toHaveLength(2);
  });

  it("records nothing when the signature does not verify", async () => {
    const { db, inserted } = makeDeliveryDb({ id: 5, channelType: "SHOPIFY" });
    const service = makeService(db);

    const outcome = await service.receiveDelivery({
      channelId: 5,
      rawBody: BODY,
      headers: { ...headersFor("d-1"), "x-shopify-hmac-sha256": "not-the-signature" },
    });

    expect(outcome).toEqual({ accepted: false, reason: "signature-mismatch" });
    expect(inserted).toEqual([]);
  });

  it("records nothing for a channel type whose secret is unset", async () => {
    const { db, inserted } = makeDeliveryDb({ id: 6, channelType: "WOOCOMMERCE" });
    const service = makeService(db);

    const outcome = await service.receiveDelivery({
      channelId: 6,
      rawBody: BODY,
      headers: {
        "x-wc-webhook-signature": signChannelPayload(SECRET, BODY),
        "x-wc-webhook-delivery-id": "wc-1",
      },
    });

    expect(outcome).toEqual({ accepted: false, reason: "no-secret-configured" });
    expect(inserted).toEqual([]);
  });

  it("refuses a channel id that resolves to no organisation", async () => {
    const { db, inserted } = makeDeliveryDb(null);
    const service = makeService(db);

    const outcome = await service.receiveDelivery({
      channelId: 999,
      rawBody: BODY,
      headers: headersFor("d-1"),
    });

    expect(outcome).toEqual({ accepted: false, reason: "unknown-channel" });
    expect(inserted).toEqual([]);
  });

  it("stores a digest of the body and never the body itself", async () => {
    // A marketplace payload carries a customer's name and address. This row
    // answers "have we handled delivery X", not "what did the customer order".
    const { db, inserted } = makeDeliveryDb({ id: 5, channelType: "SHOPIFY" });
    const service = makeService(db);

    await service.receiveDelivery({ channelId: 5, rawBody: BODY, headers: headersFor("d-1") });

    const row = inserted[0]!;
    expect(row.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("available");
  });

  it("keeps no signature header in the stored delivery metadata", async () => {
    const { db, inserted } = makeDeliveryDb({ id: 5, channelType: "SHOPIFY" });
    const service = makeService(db);

    await service.receiveDelivery({ channelId: 5, rawBody: BODY, headers: headersFor("d-1") });

    const metadata = inserted[0]!.deliveryMetadata ?? {};
    expect(Object.keys(metadata)).not.toContain("x-shopify-hmac-sha256");
    expect(metadata["x-shopify-shop-domain"]).toBe("example.myshopify.com");
  });
});

/* ------------------------------------------------------------------ *
 * The command, and the gates on it
 * ------------------------------------------------------------------ */

interface DiffRow {
  id: number;
  orgId: string;
  channelId: number;
  status: string;
  difference: string;
  externalSku: string;
  productVariantId: number | null;
}

function makeAcceptDb(input: {
  diff: DiffRow | null;
  channel: {
    id: number;
    snapshotPolicy: string;
    reconciliationLocationId: number | null;
  } | null;
  updateReturns?: Array<{ id: number }>;
}) {
  return {
    query: {
      invChannelSnapshotDiffs: { findFirst: jest.fn().mockResolvedValue(input.diff) },
      invChannels: { findFirst: jest.fn().mockResolvedValue(input.channel) },
    },
    update: jest.fn().mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(input.updateReturns ?? [{ id: 1 }]) }) }),
    }),
    select: jest.fn().mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 1 }]) }) }),
    }),
  };
}

const OPEN_DIFF: DiffRow = {
  id: 42,
  orgId: ORG,
  channelId: 5,
  status: "OPEN",
  difference: "-3.0000",
  externalSku: "SKU-A",
  productVariantId: 1,
};

describe("E6 — a snapshot cannot drive a quantity_change by itself", () => {
  it("refuses to post while the channel policy records differences only", async () => {
    // The default policy, and the one E6 calls "usually". A marketplace's stock
    // figure is that marketplace's opinion about our warehouse; an opinion that
    // could post a movement would make the ledger a mirror of whichever system
    // last spoke.
    const execute = jest.fn();
    const db = makeAcceptDb({
      diff: OPEN_DIFF,
      channel: { id: 5, snapshotPolicy: "RECORD_DIFFERENCE", reconciliationLocationId: 9 },
    });
    const service = makeService(db, { stockEngine: { execute } });

    await expect(service.acceptDiff(ORG, USER, 42, { note: "counted it myself" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to guess a location when the channel names none", async () => {
    const execute = jest.fn();
    const db = makeAcceptDb({
      diff: OPEN_DIFF,
      channel: { id: 5, snapshotPolicy: "ALLOW_ADJUSTMENT", reconciliationLocationId: null },
    });
    const service = makeService(db, { stockEngine: { execute } });

    await expect(service.acceptDiff(ORG, USER, 42, { note: "counted it myself" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to adjust for a channel SKU that matches no variant", async () => {
    const execute = jest.fn();
    const db = makeAcceptDb({
      diff: { ...OPEN_DIFF, productVariantId: null },
      channel: { id: 5, snapshotPolicy: "ALLOW_ADJUSTMENT", reconciliationLocationId: 9 },
    });
    const service = makeService(db, { stockEngine: { execute } });

    await expect(service.acceptDiff(ORG, USER, 42, { note: "counted it myself" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a difference somebody has already resolved", async () => {
    const execute = jest.fn();
    const db = makeAcceptDb({
      diff: { ...OPEN_DIFF, status: "ACCEPTED" },
      channel: { id: 5, snapshotPolicy: "ALLOW_ADJUSTMENT", reconciliationLocationId: 9 },
    });
    const service = makeService(db, { stockEngine: { execute } });

    await expect(service.acceptDiff(ORG, USER, 42, { note: "counted it myself" })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("E6 — the command an operator issues is idempotent", () => {
  it("posts one ordinary stock-engine adjustment under a key derived from the difference", async () => {
    const execute = jest.fn().mockResolvedValue({ transactionIds: [777], levels: [] });
    const db = makeAcceptDb({
      diff: OPEN_DIFF,
      channel: { id: 5, snapshotPolicy: "ALLOW_ADJUSTMENT", reconciliationLocationId: 9 },
    });
    const service = makeService(db, { stockEngine: { execute } });

    const result = await service.acceptDiff(ORG, USER, 42, { note: "physically counted the bin" });

    expect(result).toEqual({ diffId: 42, stockTransactionId: 777 });
    expect(execute).toHaveBeenCalledTimes(1);
    const [orgId, userId, command] = execute.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(orgId).toBe(ORG);
    // The operator's own id, not a system actor: warehouse scope, the
    // accounting-period gate and the audit trail all key on it.
    expect(userId).toBe(USER);
    // Derived from the row, not minted per request. Two different requests to
    // accept the same difference therefore claim the same key, and the second
    // posts nothing — which is what makes this an idempotent command rather than
    // a button somebody can double-click into two movements.
    expect(command.idempotencyKey).toBe("channel-snapshot-diff:42");
    expect(command.sourceType).toBe("channel_snapshot_diff");
    expect(command.movements).toEqual([
      {
        transactionType: "ADJUSTMENT",
        productVariantId: 1,
        locationId: 9,
        quantityDelta: "-3.0000",
      },
    ]);
  });

  it("gives the same key for the same difference on every call", async () => {
    const execute = jest.fn().mockResolvedValue({ transactionIds: [777], levels: [] });
    const db = makeAcceptDb({
      diff: OPEN_DIFF,
      channel: { id: 5, snapshotPolicy: "ALLOW_ADJUSTMENT", reconciliationLocationId: 9 },
    });
    const service = makeService(db, { stockEngine: { execute } });

    await service.acceptDiff(ORG, USER, 42, { note: "physically counted the bin" });
    await service.acceptDiff(ORG, USER, 42, { note: "physically counted the bin" });

    const keys = execute.mock.calls.map(
      (call) => (call as [string, string, { idempotencyKey: string }])[2].idempotencyKey,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("reports a lost race as a conflict rather than resolving twice", async () => {
    // Two operators accepting the same difference at once. The status guard
    // means one update affects no rows; the engine's key means only the winner's
    // movement posted, so there is nothing to undo here.
    const execute = jest.fn().mockResolvedValue({ transactionIds: [777], levels: [] });
    const db = makeAcceptDb({
      diff: OPEN_DIFF,
      channel: { id: 5, snapshotPolicy: "ALLOW_ADJUSTMENT", reconciliationLocationId: 9 },
      updateReturns: [],
    });
    const service = makeService(db, { stockEngine: { execute } });

    await expect(
      service.acceptDiff(ORG, USER, 42, { note: "physically counted the bin" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("dismisses without touching the stock engine", async () => {
    const execute = jest.fn();
    const db = makeAcceptDb({ diff: OPEN_DIFF, channel: null });
    const service = makeService(db, { stockEngine: { execute } });

    await expect(service.dismissDiff(ORG, USER, 42, { note: "a SKU mapping error" })).resolves.toEqual({
      diffId: 42,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
