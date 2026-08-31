import { PayrollFilingsService } from "../filings.service";

function makeDb(rows: unknown[] = []) {
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("PayrollFilingsService.list — pagination cap", () => {
  const orgId = "org-1";

  it("caps at 100 when caller asks for >100", async () => {
    const { db, limit } = makeDb();
    const svc = new PayrollFilingsService(db, {} as never, {} as never);
    await svc.list(orgId, 1, 200);
    expect(limit.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
  });

  it("uses default limit=50 when none supplied", async () => {
    const { db, limit } = makeDb();
    const svc = new PayrollFilingsService(db, {} as never, {} as never);
    await svc.list(orgId);
    expect(limit.mock.calls[0]?.[0]).toBe(50);
  });

  it("applies page offset correctly for page 2", async () => {
    const { db, limit } = makeDb();
    const svc = new PayrollFilingsService(db, {} as never, {} as never);
    await svc.list(orgId, 2, 10);
    const offsetMock = limit.mock.results[0]?.value as { offset: jest.Mock };
    expect(offsetMock?.offset?.mock.calls[0]?.[0]).toBe(10);
  });
});
