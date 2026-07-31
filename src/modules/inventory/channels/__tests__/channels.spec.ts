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

function makeCache() {
  return {
    cached: jest.fn().mockImplementation((_k: string, fn: () => Promise<unknown>) => fn()),
    invalidate: jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
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
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }]))
        .mockReturnValueOnce(makeWhereChain([{ productVariantId: 1, onHand: "10", committed: "2", blockedQty: "0", qualityHoldQty: "0" }])),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
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
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }]))
        .mockReturnValueOnce(makeWhereChain([{ productVariantId: 1, onHand: "5", committed: "4", blockedQty: "0", qualityHoldQty: "0" }])),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
    const result = await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(result.synced).toBe(1);
    expect(insertedValues[0]).toMatchObject({ publishedQty: "0.0000" });
  });

  it("skips variant when publishable is below threshold", async () => {
    const channel = buildChannel({ safetyBuffer: "0", publishThreshold: "3" });

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }]))
        .mockReturnValueOnce(makeWhereChain([{ productVariantId: 1, onHand: "2", committed: "0", blockedQty: "0", qualityHoldQty: "0" }])),
      insert: jest.fn().mockReturnValue(makeInsertChain()),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
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
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }]))
        .mockReturnValueOnce(makeWhereChain([{ productVariantId: 1, onHand: "5", committed: "0", blockedQty: "0", qualityHoldQty: "0" }])),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
    await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(insertedValues[0]).toMatchObject({ status: "PUBLISHED", error: null });
  });

  it("sets status FAILED with 'Provider not connected' for SHOPIFY channel", async () => {
    const channel = buildChannel({ channelType: "SHOPIFY", safetyBuffer: "0", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }]))
        .mockReturnValueOnce(makeWhereChain([{ productVariantId: 1, onHand: "5", committed: "0", blockedQty: "0", qualityHoldQty: "0" }])),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
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

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
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

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
    await expect(service.syncStock(ORG, USER, CHANNEL_ID)).rejects.toThrow(NotFoundException);
  });

  it("accounts for blockedQty and qualityHoldQty in available calculation", async () => {
    const channel = buildChannel({ safetyBuffer: "0", publishThreshold: "0" });
    const insertedValues: Record<string, unknown>[] = [];

    const db = {
      query: { invChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      select: jest.fn()
        .mockReturnValueOnce(makeWhereChain([{ id: 1 }]))
        .mockReturnValueOnce(makeWhereChain([{ productVariantId: 1, onHand: "20", committed: "2", blockedQty: "3", qualityHoldQty: "4" }])),
      insert: jest.fn().mockReturnValue(makeInsertChain(insertedValues)),
    };

    const service = new ChannelsService(db as never, makeCache() as never, makeAudit() as never);
    await service.syncStock(ORG, USER, CHANNEL_ID);

    expect(insertedValues[0]).toMatchObject({ publishedQty: "11.0000", availableQty: "11.0000" });
  });
});
