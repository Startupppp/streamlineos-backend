import {
  hasCompatibleHolidays,
  listCompatibleHolidays,
  mergeCompatibleHolidays,
} from "./organization-holidays";

function selectQuery(rows: unknown[]) {
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(rows),
        }),
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe("organization holiday compatibility", () => {
  it("keeps canonical rows when both stores contain the same holiday", () => {
    const rows = mergeCompatibleHolidays(
      [
        {
          id: "canonical-id",
          name: "Founders Day",
          date: "2026-08-15",
          source: "canonical",
        },
      ],
      [
        {
          id: "legacy:7",
          name: " founders day ",
          date: "2026-08-15",
          source: "legacy",
        },
        {
          id: "legacy:8",
          name: "Regional Holiday",
          date: "2026-08-16",
          source: "legacy",
        },
      ],
    );

    expect(rows).toEqual([
      {
        id: "canonical-id",
        name: "Founders Day",
        date: "2026-08-15",
        source: "canonical",
      },
      {
        id: "legacy:8",
        name: "Regional Holiday",
        date: "2026-08-16",
        source: "legacy",
      },
    ]);
  });

  it("reads both tenant-scoped stores and source-qualifies legacy ids", async () => {
    const select = jest
      .fn()
      .mockReturnValueOnce(
        selectQuery([{ id: "canonical-id", name: "Canonical", date: "2026-01-01" }]),
      )
      .mockReturnValueOnce(
        selectQuery([{ id: 12, name: "Legacy", date: "2026-01-02" }]),
      );

    const rows = await listCompatibleHolidays(
      { select } as never,
      "org-1",
      "2026-01-01",
      "2026-12-31",
    );

    expect(select).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.id)).toEqual(["canonical-id", "legacy:12"]);
  });

  it("reports setup complete when either store has a row", async () => {
    const select = jest
      .fn()
      .mockReturnValueOnce(selectQuery([]))
      .mockReturnValueOnce(selectQuery([{ id: 4 }]));

    await expect(hasCompatibleHolidays({ select } as never, "org-1")).resolves.toBe(true);
  });
});
