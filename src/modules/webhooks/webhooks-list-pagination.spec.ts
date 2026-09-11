import { BadRequestException } from "@nestjs/common";
import { decodeCursor, encodeCursor } from "../../common/pagination/cursor";
import { listSchema, logsSchema } from "./dto/webhook.schemas";
import { WebhooksService } from "./webhooks.service";

describe("WebhooksService.list", () => {
  it("uses a newest-first keyset, trims its sentinel, and never exposes endpoint secrets", async () => {
    const rows = [
      {
        id: 42,
        orgId: "org-1",
        url: "https://example.com/hook",
        secret: "must-not-leak",
        description: null,
        events: ["lead.created"],
        isActive: true,
        createdBy: "user-1",
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        id: 41,
        orgId: "org-1",
        url: "https://example.com/older-hook",
        secret: "must-not-leak",
        description: null,
        events: [],
        isActive: true,
        createdBy: "user-1",
        createdAt: new Date("2026-07-31T00:00:00.000Z"),
        updatedAt: new Date("2026-07-31T00:00:00.000Z"),
      },
      {
        id: 40,
        orgId: "org-1",
        url: "https://example.com/sentinel",
        secret: "must-not-leak",
        description: null,
        events: [],
        isActive: true,
        createdBy: "user-1",
        createdAt: new Date("2026-07-30T00:00:00.000Z"),
        updatedAt: new Date("2026-07-30T00:00:00.000Z"),
      },
    ];
    const findMany = jest.fn().mockResolvedValue(rows);
    const db = {
      query: { webhookEndpoints: { findMany } },
    };
    const service = new WebhooksService(db as never);

    const result = await service.list("org-1", { limit: 2 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
    expect(result.data).toHaveLength(2);
    expect(result.data).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ secret: expect.anything() }),
      expect.objectContaining({ id: 40 }),
    ]));
    expect(result.pagination).toMatchObject({ limit: 2, hasMore: true });
    expect(decodeCursor(result.pagination.nextCursor)).toEqual({
      sortValue: "2026-07-31T00:00:00.000Z",
      id: "41",
    });
  });

  it("rejects a malformed cursor with a client error before querying", async () => {
    const findMany = jest.fn();
    const service = new WebhooksService({
      query: { webhookEndpoints: { findMany } },
    } as never);

    await expect(service.list("org-1", { cursor: "not-a-cursor", limit: 20 }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects a decodable cursor whose timestamp or id is invalid", async () => {
    const findMany = jest.fn();
    const service = new WebhooksService({
      query: { webhookEndpoints: { findMany } },
    } as never);
    const cursor = encodeCursor({ sortValue: "not-a-timestamp", id: "not-an-id" });

    await expect(service.list("org-1", { cursor, limit: 20 }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("hard-caps endpoint and delivery-log page sizes", () => {
    expect(listSchema.parse({ limit: 1_000 })).toEqual({ limit: 100 });
    expect(logsSchema.parse({ limit: 1_000 })).toEqual({ limit: 100 });
  });
});
