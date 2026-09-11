import { SalaryStructureTemplatesService } from "../salary-structure-templates.service";

function makeDb(rows: unknown[] = []) {
  const limit = jest.fn().mockResolvedValue(rows);
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  return { db: { select } as never, limit };
}

describe("SalaryStructureTemplatesService.list cursor pagination", () => {
  it("caps at 100 and over-fetches one sentinel row", async () => {
    const { db, limit } = makeDb();
    await new SalaryStructureTemplatesService(db).list("org-1", undefined, 500);
    expect(limit).toHaveBeenCalledWith(101);
  });

  it("returns null nextCursor on the final page", async () => {
    const { db } = makeDb([
      { id: 1, createdAt: new Date("2026-09-01T00:00:00.000Z") },
    ]);
    const result = await new SalaryStructureTemplatesService(db).list(
      "org-1",
      undefined,
      50,
    );
    expect(result.pagination).toEqual({
      limit: 50,
      hasMore: false,
      nextCursor: null,
    });
  });
});
