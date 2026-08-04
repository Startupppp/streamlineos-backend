import { syncCanonicalEmploymentFields } from "./sync-canonical-employment-fields";

function primitives(value: unknown, seen = new WeakSet<object>()): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => primitives(entry, seen));
}

describe("syncCanonicalEmploymentFields", () => {
  function setup(returnedRows: Array<{ id: number }>) {
    const personWhere = jest.fn((_predicate: unknown) => ({ sql: "person-subquery" }));
    const select = jest.fn(() => ({ from: () => ({ where: personWhere }) }));
    const returning = jest.fn().mockResolvedValue(returnedRows);
    const employmentWhere = jest.fn((_predicate: unknown) => ({ returning }));
    const set = jest.fn(() => ({ where: employmentWhere }));
    const update = jest.fn(() => ({ set }));
    return { db: { select, update }, personWhere, employmentWhere, set };
  }

  it("atomically scopes the canonical update by organization and person user", async () => {
    const { db, personWhere, employmentWhere, set } = setup([{ id: 9 }]);
    await expect(
      syncCanonicalEmploymentFields(db as never, "org-1", "user-1", {
        designation: "Staff Engineer",
        departmentId: "dept-1",
        joiningDate: "2026-02-03",
      }),
    ).resolves.toBe(true);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        designation: "Staff Engineer",
        departmentId: "dept-1",
        joiningDate: "2026-02-03",
      }),
    );
    expect(primitives(personWhere.mock.calls[0][0])).toEqual(
      expect.arrayContaining(["org-1", "user-1"]),
    );
    expect(primitives(employmentWhere.mock.calls[0][0])).toEqual(
      expect.arrayContaining(["org-1", true]),
    );
  });

  it("returns false telemetry when canonical employment backfill is missing", async () => {
    const { db } = setup([]);
    await expect(
      syncCanonicalEmploymentFields(db as never, "org-1", "user-1", {
        designation: "Engineer",
      }),
    ).resolves.toBe(false);
  });
});
