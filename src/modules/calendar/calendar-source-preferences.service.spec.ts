import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";

function makeDb(rows: Array<{ sourceKey: string }> = []) {
  const where = jest.fn().mockResolvedValue(rows);
  const select = jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({ where }),
  });

  const deleteWhere = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockReturnValue({ where: deleteWhere });

  const conflict = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate: conflict });
  const insert = jest.fn().mockReturnValue({ values });

  return {
    db: { select, delete: remove, insert },
    select,
    where,
    remove,
    deleteWhere,
    insert,
    values,
    conflict,
  };
}

describe("CalendarSourcePreferencesService", () => {
  it("returns only disabled source keys for the requested person and organisation", async () => {
    const mocks = makeDb([{ sourceKey: "hr-leaves" }, { sourceKey: "tasks" }]);
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await expect(service.getDisabledKeys("org-1", "user-1")).resolves.toEqual(
      new Set(["hr-leaves", "tasks"]),
    );
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.where).toHaveBeenCalledTimes(1);
  });

  it("stores an explicit opt-out and upserts repeated changes", async () => {
    const mocks = makeDb();
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await service.setPreference("org-1", "user-1", "hr-leaves", false);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledWith({
      orgId: "org-1",
      userId: "user-1",
      sourceKey: "hr-leaves",
      enabled: false,
    });
    expect(mocks.conflict).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ enabled: false }) }),
    );
  });

  it("removes an opt-out when the source is enabled again", async () => {
    const mocks = makeDb();
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await service.setPreference("org-1", "user-1", "hr-leaves", true);

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
