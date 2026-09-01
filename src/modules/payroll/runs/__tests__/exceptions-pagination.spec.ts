import { ExceptionsService } from "../exceptions.service";

function makeDb(runRows: unknown[], exceptionRows: unknown[] = []) {
  const exLimit = jest.fn().mockResolvedValue(exceptionRows);
  const exOrderBy = jest.fn().mockReturnValue({ limit: exLimit });
  const exWhere = jest.fn().mockReturnValue({ orderBy: exOrderBy });
  const exLeftJoin = jest.fn().mockReturnValue({ where: exWhere });
  const exFrom = jest.fn().mockReturnValue({ leftJoin: exLeftJoin });

  const runLimit = jest.fn().mockResolvedValue(runRows);
  const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
  const runFrom = jest.fn().mockReturnValue({ where: runWhere });

  const select = jest
    .fn()
    .mockReturnValueOnce({ from: runFrom })
    .mockReturnValue({ from: exFrom });

  return { db: { select } as never, exLimit };
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
    const { db } = makeDb([run], [
      {
        id: 1,
        severity: "BLOCKER",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    ]);
    const result = await new ExceptionsService(db).listExceptions("org-1", 10);
    expect(result?.pagination).toEqual({
      limit: 50,
      hasMore: false,
      nextCursor: null,
    });
  });

  it("returns null when the tenant-scoped run is absent", async () => {
    const { db } = makeDb([]);
    await expect(
      new ExceptionsService(db).listExceptions("attacker-org", 999),
    ).resolves.toBeNull();
  });
});
