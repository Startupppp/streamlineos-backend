import { NotFoundException } from "@nestjs/common";
import { ChannelsService } from "../channels.service";

function makeWhereChain(result: unknown[]) {
  const where = jest.fn().mockResolvedValue(result);
  const from = jest.fn().mockReturnValue({ where });
  return { from };
}

function makeInsertChain(insertedValues: Record<string, unknown>[] = []) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockImplementation((v: unknown) => {
    const rows = Array.isArray(v) ? v : [v];
    for (const row of rows) insertedValues.push(row as Record<string, unknown>);
    return { onConflictDoUpdate };
  });
  return { values };
}

function makeAudit() {
  return { insert: jest.fn().mockResolvedValue(undefined) };
}

/**
 * `ChannelPoolService`, of which `syncStock` uses exactly one method.
 * `recordPublishedInTx` is real on that class — a double for a method the
 * service does not have is what check:mock-surface exists to catch.
 */
function makePools() {
  return { recordPublishedInTx: jest.fn().mockResolvedValue(undefined) };
}

function makeCache() {
  return {
    cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
  };
}

const ORG = "org1";
const USER = "u1";
const CHANNEL_ID = 1;

function buildChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    orgId: ORG,
    status: "ACTIVE",
    channelType: "INTERNAL",
    warehouseIds: [1],
    safetyBuffer: "0",
    publishThreshold: "0",
    ...overrides,
  };
}

describe("ChannelsService.syncStock — publishable math", () => {
  it("publishes variant with publishable=7 when onHand=10, committed=2, safetyBuffer=1, threshold=0", async () => {
    const channel = buildChannel({ safetyBuffer: "1", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 1, available: "8.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result.synced).toBe(1);
    expect(result.skipped).toBe(0);
    expect(insertedValues[0]).toMatchObject({ publishedQty: "7.0000", status: "PUBLISHED" });
  });

  it("syncs variant with qty 0 when publishable is 0 and threshold is 0", async () => {
    const channel = buildChannel({ safetyBuffer: "2", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 1, available: "1.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result.synced).toBe(1);
    expect(insertedValues[0]).toMatchObject({ publishedQty: "0.0000" });
  });

  it("skips variant when publishable is below threshold", async () => {
    const channel = buildChannel({ safetyBuffer: "0", publishThreshold: "3" });

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 1, available: "2.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain()),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("sets status PUBLISHED for INTERNAL channel", async () => {
    const channel = buildChannel({ channelType: "INTERNAL", safetyBuffer: "0", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 1, available: "5.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(insertedValues[0]).toMatchObject({ status: "PUBLISHED", error: null });
  });

  it("sets status FAILED with 'Provider not connected' for SHOPIFY channel", async () => {
    const channel = buildChannel({ channelType: "SHOPIFY", safetyBuffer: "0", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 1, available: "5.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result.synced).toBe(1);
    expect(insertedValues[0]).toMatchObject({ status: "FAILED", error: "Provider not connected" });
  });

  it("returns synced=0 skipped=0 when channel is PAUSED", async () => {
    const channel = buildChannel({ status: "PAUSED" });

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn(),
      insert: jest.fn(),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result).toEqual({ synced: 0, skipped: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("throws NotFoundException when channel does not exist", async () => {
    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(null) } },
      select: jest.fn(),
      insert: jest.fn(),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    await expect(service.syncStock(ORG, USER, CHANNEL_ID)).rejects.toThrow(NotFoundException);
  });

  it("accounts for blockedQty and qualityHoldQty in available calculation", async () => {
    const channel = buildChannel({ safetyBuffer: "0", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 1, available: "11.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, makePools() as never);
    await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(insertedValues[0]).toMatchObject({ publishedQty: "11.0000", availableQty: "11.0000" });
  });
  /**
   * `inv_channel_pools.published_qty` had NO writer anywhere in the codebase.
   * `listForChannel`, `listForVariant` and the allocate result all select it, and
   * `channel-pools.controller.ts` serves the first two, so the API reported the
   * column DEFAULT '0' for every pool row forever while the real figure sat in
   * `inv_channel_stock_publications`. These two pin the writer and its condition;
   * both fail against the code before this fix — the first because nothing called
   * the recorder at all.
   */
  it("records the published figure onto the channel pool row", async () => {
    const channel = buildChannel({ safetyBuffer: "1", publishThreshold: "0" });
    const pools = makePools();

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn().mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 7, available: "8.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain([])),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, pools as never);
    await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(pools.recordPublishedInTx).toHaveBeenCalledTimes(1);
    const [, orgArg, rowsArg] = pools.recordPublishedInTx.mock.calls[0];
    expect(orgArg).toBe(ORG);
    // The same number the publication row carries, not the raw availability:
    // 8 available less a safety buffer of 1.
    expect(rowsArg).toEqual([{ channelId: CHANNEL_ID, productVariantId: 7, publishedQty: "7.0000" }]);
  });

  it("does not record a published figure when the channel was never told", async () => {
    // Any non-INTERNAL channel publishes as FAILED ("Provider not connected").
    // A channel that was told nothing has no last-told figure, so writing one
    // would be a number the operator can act on that never left the building.
    const channel = buildChannel({ channelType: "MARKETPLACE", safetyBuffer: "0", publishThreshold: "0" });
    const pools = makePools();

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn().mockReturnValueOnce(makeWhereChain([{ id: 1 }])),
      execute: jest.fn().mockResolvedValue([{ product_variant_id: 7, available: "8.0000" }]),
      insert: jest.fn().mockReturnValue(makeInsertChain([])),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never, pools as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result.synced).toBe(1);
    expect(pools.recordPublishedInTx).not.toHaveBeenCalled();
  });
});
