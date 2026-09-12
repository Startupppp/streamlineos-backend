import { createHash, createHmac } from "node:crypto";
import { receiveDelivery } from "../lib/channel-snapshot-delivery";
import type { Db } from "../../../../db/drizzle.module";

describe("Shopify Webhook Ingest Deduplication (INV-27)", () => {
  it("deduplicates identical webhook deliveries by providerDeliveryId", async () => {
    const orgId = "org_test_dedupe";
    const channelId = 42;
    const providerDeliveryId = "sh_deliv_unique_99999";
    const rawBody = JSON.stringify({
      id: 123456789,
      email: "customer@example.com",
      created_at: "2026-09-12T10:00:00Z",
      line_items: [{ sku: "SKU-TEST-1", quantity: 1, price: "25.00" }],
    });

    const deliveries: { id: number; orgId: string; channelId: number; providerDeliveryId: string }[] = [];

    const mockTx = {
      execute: jest.fn().mockResolvedValue([{ app_tenant_isolation_mode: "unrestricted" }]),
      query: {
        invChannels: {
          findFirst: jest.fn().mockResolvedValue({
            id: channelId,
            channelType: "SHOPIFY",
            status: "ACTIVE",
          }),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          onConflictDoNothing: jest.fn().mockImplementation(() => {
            return {
              returning: jest.fn().mockImplementation(() => {
                const isDuplicate = deliveries.some((d) => d.providerDeliveryId === providerDeliveryId);
                if (isDuplicate) {
                  return Promise.resolve([]);
                }
                const newRow = { id: 101, orgId, channelId, providerDeliveryId };
                deliveries.push(newRow);
                return Promise.resolve([{ id: 101 }]);
              }),
            };
          }),
        }),
      }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 101 }]),
          }),
        }),
      }),
    };

    const mockDb = {
      execute: jest.fn().mockResolvedValue([{ org_id: orgId }]),
      transaction: jest.fn().mockImplementation(async (cb) => cb(mockTx)),
    } as unknown as Db;

    const mockConfig = {
      INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY: "test-shopify-secret-32-chars-long!",
    } as any;

    const mockLogger = { warn: jest.fn(), log: jest.fn() } as any;

    const signature = createHmac("sha256", mockConfig.INV_CHANNEL_WEBHOOK_SECRET_SHOPIFY)
      .update(rawBody)
      .digest("base64");

    const input = {
      channelId,
      rawBody,
      headers: {
        "x-shopify-webhook-id": providerDeliveryId,
        "x-shopify-topic": "orders/create",
        "x-shopify-hmac-sha256": signature,
      },
    };

    // First delivery -> accepted, duplicate = false
    const res1 = await receiveDelivery(
      { db: mockDb, config: mockConfig, logger: mockLogger },
      input,
    );
    expect(res1.accepted).toBe(true);
    if (res1.accepted) {
      expect(res1.duplicate).toBe(false);
    }

    // Second delivery (same providerDeliveryId) -> accepted, duplicate = true (only 1 import enqueued)
    const res2 = await receiveDelivery(
      { db: mockDb, config: mockConfig, logger: mockLogger },
      input,
    );
    expect(res2.accepted).toBe(true);
    if (res2.accepted) {
      expect(res2.duplicate).toBe(true);
    }
  });
});
