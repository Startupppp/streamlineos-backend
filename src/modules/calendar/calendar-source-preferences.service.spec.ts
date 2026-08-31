import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";

const ORG = "org-1";
const USER = "user-1";
const MEMBERSHIP_ID = 42;

function makeDb(rows: Array<{ sourceKey: string }> = [], membership: { id: number } | null = { id: MEMBERSHIP_ID }) {
  const findFirst = jest.fn().mockResolvedValue(membership);

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
    db: {
      select,
      delete: remove,
      insert,
      query: { organizationMembers: { findFirst } },
    },
    select,
    where,
    remove,
    deleteWhere,
    insert,
    values,
    conflict,
    findFirst,
  };
}

describe("CalendarSourcePreferencesService", () => {
  it("returns only disabled source keys for the requested membership", async () => {
    const mocks = makeDb([{ sourceKey: "hr-leaves" }, { sourceKey: "tasks" }]);
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await expect(service.getDisabledKeys(ORG, USER)).resolves.toEqual(
      new Set(["hr-leaves", "tasks"]),
    );
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.where).toHaveBeenCalledTimes(1);
  });

  it("returns empty set when caller has no active membership", async () => {
    const mocks = makeDb([{ sourceKey: "hr-leaves" }], null);
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await expect(service.getDisabledKeys(ORG, USER)).resolves.toEqual(new Set());
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("stores an explicit opt-out keyed on membershipId", async () => {
    const mocks = makeDb();
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await service.setPreference(ORG, USER, "hr-leaves", false);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledWith({
      orgId: ORG,
      membershipId: MEMBERSHIP_ID,
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

    await service.setPreference(ORG, USER, "hr-leaves", true);

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("does nothing when membership cannot be resolved and preference is set", async () => {
    const mocks = makeDb([], null);
    const service = new CalendarSourcePreferencesService(mocks.db as never);

    await service.setPreference(ORG, USER, "hr-leaves", false);

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
