import { ExceptionsService } from "../exceptions.service";

function makeDb(runRows: unknown[], exceptionRows: unknown[] = [], total = 0) {
  const exLimit = jest.fn().mockResolvedValue(exceptionRows);
  const exOrderBy = jest.fn().mockReturnValue({ limit: exLimit });
  const exWhere = jest.fn().mockReturnValue({ orderBy: exOrderBy });
  const exLeftJoin = jest.fn().mockReturnValue({ where: exWhere });
  const exFrom = jest.fn().mockReturnValue({ leftJoin: exLeftJoin });

  const countWhere = jest.fn().mockResolvedValue([{ value: total }]);
  const countFrom = jest.fn().mockReturnValue({ where: countWhere });

  const runLimit = jest.fn().mockResolvedValue(runRows);
  const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
  const runFrom = jest.fn().mockReturnValue({ where: runWhere });

  const select = jest
    .fn()
    .mockReturnValueOnce({ from: runFrom })
    .mockReturnValueOnce({ from: countFrom })
    .mockReturnValue({ from: exFrom });

  return { db: { select } as never, exLimit, countWhere, exWhere };
}

describe("ExceptionsService.listExceptions cursor pagination", () => {
  const run = { id: 10 };

  it("caps at 100 and requests a sentinel row", async () => {
    const { db, exLimit } = makeDb([run]);
    await new ExceptionsService(db).listExceptions(
      "org-1",
      10,
      undefined,
      undefined,
      undefined,
      200,
    );
    expect(exLimit).toHaveBeenCalledWith(101);
  });

  it("returns cursor metadata for the final page", async () => {
    const { db } = makeDb(
      [run],
      [
        {
          id: 1,
          severity: "BLOCKER",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      ],
      1,
    );
    const result = await new ExceptionsService(db).listExceptions("org-1", 10);
    expect(result?.pagination).toEqual({
      limit: 50,
      hasMore: false,
      nextCursor: null,
      total: 1,
    });
  });

  it("returns null when the tenant-scoped run is absent", async () => {
    const { db } = makeDb([]);
    await expect(
      new ExceptionsService(db).listExceptions("attacker-org", 999),
    ).resolves.toBeNull();
  });

  it("reports the filter-wide total rather than the number of rows on the page", async () => {
    const { db } = makeDb(
      [run],
      [
        { id: 1, severity: "BLOCKER", createdAt: new Date("2026-09-01T00:00:00.000Z") },
        { id: 2, severity: "WARNING", createdAt: new Date("2026-09-02T00:00:00.000Z") },
      ],
      137,
    );
    const result = await new ExceptionsService(db).listExceptions("org-1", 10);

    expect(result?.data).toHaveLength(2);
    expect(result?.pagination.total).toBe(137);
  });

  it("counts a measured zero rather than leaving the caller to guess", async () => {
    const { db } = makeDb([run], [], 0);
    const result = await new ExceptionsService(db).listExceptions("org-1", 10);

    expect(result?.data).toEqual([]);
    expect(result?.pagination.total).toBe(0);
  });

  it("never runs the count before the run has been tenant-checked", async () => {
    const { db, countWhere } = makeDb([]);
    await new ExceptionsService(db).listExceptions("attacker-org", 999);

    expect(countWhere).not.toHaveBeenCalled();
  });
});
