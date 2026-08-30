import { PublishingService } from "./publishing.service";
import type { Db } from "../../../db/drizzle.module";

describe("PublishingService — listPublications cap", () => {
  afterEach(() => jest.resetAllMocks());

  function makeDb(publicationsFindMany: jest.Mock) {
    return {
      query: {
        payrollRuns: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        payslipPublications: { findMany: publicationsFindMany },
      },
    } as unknown as Db;
  }

  function makeSvc(db: Db) {
    return new PublishingService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it("applies PUBLICATION_LIST_CAP limit to the payslipPublications query", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = makeSvc(makeDb(findMany));

    await svc.listPublications("org-1", 1);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]?.[0] as { limit?: number } | undefined;
    expect(typeof args?.limit).toBe("number");
    expect(args!.limit).toBeGreaterThan(0);
    expect(args!.limit).toBeLessThanOrEqual(5_000);
  });

  it("truncated is false when fewer than cap rows returned", async () => {
    const pub = { id: 1, userId: "u1", workerId: null, runEmployeeId: 1, status: "PUBLISHED", channel: "PDF", pdfUrl: null, publishedAt: null, snapshotHash: "x", failureReason: null, attemptCount: 1, lastAttemptAt: null };
    const findMany = jest.fn().mockResolvedValue([pub]);
    const svc = makeSvc(makeDb(findMany));

    const result = await svc.listPublications("org-1", 1);

    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it("truncated is true when exactly cap rows are returned", async () => {
    const cap = 1_000;
    const rows = Array.from({ length: cap }, (_, i) => ({ id: i + 1, userId: `u${i}`, workerId: null, runEmployeeId: i + 1, status: "PUBLISHED", channel: "PDF", pdfUrl: null, publishedAt: null, snapshotHash: "x", failureReason: null, attemptCount: 1, lastAttemptAt: null }));
    const findMany = jest.fn().mockResolvedValue(rows);
    const svc = makeSvc(makeDb(findMany));

    const result = await svc.listPublications("org-1", 1);

    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(cap);
  });
});
