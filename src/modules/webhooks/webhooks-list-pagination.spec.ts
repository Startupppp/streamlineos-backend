import { WebhooksService } from "./webhooks.service";

describe("WebhooksService.list", () => {
  it("returns a stable page contract without exposing endpoint secrets", async () => {
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
    ];
    const findMany = jest.fn().mockResolvedValue(rows);
    const countWhere = jest.fn().mockResolvedValue([{ total: 41 }]);
    const db = {
      query: { webhookEndpoints: { findMany } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: countWhere }),
      }),
    };
    const service = new WebhooksService(db as never);

    const result = await service.list("org-1", { page: 2, limit: 20 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 20 }),
    );
    expect(result).toEqual({
      data: [expect.not.objectContaining({ secret: expect.anything() })],
      pagination: {
        page: 2,
        limit: 20,
        total: 41,
        totalPages: 3,
      },
    });
  });
});
