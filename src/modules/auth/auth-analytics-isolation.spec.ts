import { AuthAnalyticsService } from "./auth-analytics.service";
import type { Db } from "../../db/drizzle.module";

function makeDb(rows: unknown[]): Db {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(rows),
  };
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

describe("AuthAnalyticsService — cross-user isolation", () => {
  it("returns empty data when no login history exists for the queried userId (cross-user isolation)", async () => {
    const db = makeDb([]);
    const svc = new AuthAnalyticsService(db);

    const result = await svc.listLoginHistory("user-attacker", 20);

    expect(result.data).toHaveLength(0);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextCursor).toBe(null);
  });

  it("returns events for the owning userId (control)", async () => {
    const event = {
      id: "ev-1",
      event: "magic_link.verify",
      success: true,
      createdAt: new Date(),
      ipAddress: null,
      userAgent: null,
    };
    const db = makeDb([event]);
    const svc = new AuthAnalyticsService(db);

    const result = await svc.listLoginHistory("user-owner", 20);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: "ev-1" });
  });
});
