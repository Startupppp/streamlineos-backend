import { ExceptionsService } from "../exceptions.service";

function makeDb(runRows: unknown[], exceptionRows: unknown[] = []) {
  const exOffset = jest.fn().mockResolvedValue(exceptionRows);
  const exLimit = jest.fn().mockReturnValue({ offset: exOffset });
  const exOrderBy = jest.fn().mockReturnValue({ limit: exLimit });
  const exWhere = jest.fn().mockReturnValue({ orderBy: exOrderBy });
  const exLeftJoin = jest.fn().mockReturnValue({ where: exWhere });
  const exFrom = jest.fn().mockReturnValue({ leftJoin: exLeftJoin });

  const runLimit = jest.fn().mockResolvedValue(runRows);
  const runWhere = jest.fn().mockReturnValue({ limit: runLimit });
  const runFrom = jest.fn().mockReturnValue({ where: runWhere });

  const select = jest.fn()
    .mockReturnValueOnce({ from: runFrom })
    .mockReturnValue({ from: exFrom });

  return { db: { select } as never, exLimit };
}

describe("ExceptionsService.listExceptions — pagination cap", () => {
  const orgId = "org-1";
  const runId = 10;
  const run = { id: runId };

  it("caps at 100 when caller asks for >100", async () => {
    const { db, exLimit } = makeDb([run]);
    const svc = new ExceptionsService(db);
    await svc.listExceptions(orgId, runId, undefined, undefined, 1, 200);
    expect(exLimit.mock.calls[0]?.[0]).toBeLessThanOrEqual(100);
  });

  it("uses defaults (page=1, limit=50) when none supplied", async () => {
    const { db, exLimit } = makeDb([run]);
    const svc = new ExceptionsService(db);
    await svc.listExceptions(orgId, runId);
    expect(exLimit.mock.calls[0]?.[0]).toBe(50);
  });

  it("returns null when run is not found (cross-tenant isolation)", async () => {
    const { db } = makeDb([]);
    const svc = new ExceptionsService(db);
    const result = await svc.listExceptions("attacker-org", 999);
    expect(result).toBeNull();
  });
});
