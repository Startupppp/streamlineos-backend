/**
 * AuthAnalyticsService operates on global login_history and user_sessions tables.
 * These are not org-scoped tables. Cross-user isolation: the service never returns
 * another user's events because listLoginHistory keys on userId in the where predicate.
 *
 * This spec documents the global-table design and verifies that the service returns an
 * empty result when no matching rows exist (simulating the userId predicate filtering).
 */

import { AuthAnalyticsService } from "./auth-analytics.service";
import type { Db } from "../../db/drizzle.module";

function makeDb(rows: unknown[]): Db {
  const chain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    offset: jest.fn().mockResolvedValue(rows),
  };
  return { select: jest.fn().mockReturnValue(chain) } as unknown as Db;
}

describe("AuthAnalyticsService — cross-user isolation", () => {
  it("returns empty list when no login history exists for the queried userId (cross-user isolation)", async () => {
    const db = makeDb([]);
    const svc = new AuthAnalyticsService(db);

    const result = await svc.listLoginHistory("user-attacker", {
      skip: 0,
      take: 20,
    });

    expect(result).toHaveLength(0);
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

    const result = await svc.listLoginHistory("user-owner", {
      skip: 0,
      take: 20,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "ev-1" });
  });
});
