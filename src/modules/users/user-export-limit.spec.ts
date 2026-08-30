import { UserOperationsReporter } from "./user-operations.reporter";
import type { Db } from "../../db/drizzle.module";
import type { CacheService } from "../../common/cache/cache.service";
import type { EmploymentFactsService } from "../directory/employment-facts.service";

describe("UserOperationsReporter — export cap", () => {
  afterEach(() => jest.resetAllMocks());

  function makeReporter(limitMock: jest.Mock) {
    const orderByMock = jest.fn().mockReturnValue({ limit: limitMock });
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
    const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
    const db = { select: jest.fn().mockReturnValue({ from: fromMock }) } as unknown as Db;

    const cache = {} as unknown as CacheService;
    const employment = {
      getFactsBatch: jest.fn().mockResolvedValue(new Map()),
    } as unknown as EmploymentFactsService;

    return new UserOperationsReporter(db, cache, employment);
  }

  it("passes EXPORT_USERS_CAP as the limit argument to the query chain", async () => {
    const limitMock = jest.fn().mockResolvedValue([]);
    const reporter = makeReporter(limitMock);

    await reporter.exportUsers("org-1");

    expect(limitMock).toHaveBeenCalledTimes(1);
    const [limitArg] = limitMock.mock.calls[0] as [number];
    expect(typeof limitArg).toBe("number");
    expect(limitArg).toBeGreaterThan(0);
    expect(limitArg).toBeLessThanOrEqual(10_000);
  });

  it("truncated is false when fewer than cap rows returned", async () => {
    const row = { id: "u1", email: "a@b.com", firstName: "A", lastName: "B", role: "MEMBER", membershipStatus: "ACTIVE", emailVerified: true, phone: null, joinedAt: new Date(), createdAt: new Date() };
    const limitMock = jest.fn().mockResolvedValue([row]);
    const reporter = makeReporter(limitMock);

    const result = await reporter.exportUsers("org-1");

    expect(result.truncated).toBe(false);
    expect(result.rowCount).toBe(1);
  });

  it("truncated is true when exactly cap rows are returned", async () => {
    const cap = 5_000;
    const rows = Array.from({ length: cap }, (_, i) => ({
      id: `u${i}`,
      email: `u${i}@x.com`,
      firstName: "F",
      lastName: "L",
      role: "MEMBER",
      membershipStatus: "ACTIVE",
      emailVerified: true,
      phone: null,
      joinedAt: new Date(),
      createdAt: new Date(),
    }));
    const limitMock = jest.fn().mockResolvedValue(rows);
    const reporter = makeReporter(limitMock);

    const result = await reporter.exportUsers("org-1");

    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(cap);
  });
});
