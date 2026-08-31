import { HrHolidaysService } from "./hr-holidays.service";
import { HrLeaveBlackoutService } from "./hr-leave-blackout.service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (!isRecord(value) || seen.has(value)) return [];

  seen.add(value);
  const chunks = value.queryChunks;
  const nestedValue = value.value;
  return [
    ...(Array.isArray(chunks) ? sqlValues(chunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(value, "value") ? sqlValues(nestedValue, seen) : []),
  ];
}

describe("HrHolidaysService cross-tenant isolation", () => {
  it("hides a holiday from a different org and scopes the lookup predicate", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new HrHolidaysService(
      { query: { holidays: { findFirst } } } as never,
      { emit: jest.fn() } as never,
    );

    await expect(service.getById("org-b", 41)).resolves.toBeNull();

    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toEqual(
      expect.arrayContaining([41, "org-b"]),
    );
  });

  it("does not mutate a holiday owned by a different org", async () => {
    const where = jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) });
    const service = new HrHolidaysService(
      { update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }) } as never,
      { emit: jest.fn() } as never,
    );

    await expect(
      service.update("org-b", 41, { name: "Updated", date: "2026-01-01" }),
    ).resolves.toBeUndefined();

    expect(sqlValues(where.mock.calls[0]?.[0])).toEqual(expect.arrayContaining([41, "org-b"]));
  });
});

describe("HrLeaveBlackoutService cross-tenant isolation", () => {
  it("hides a blackout date from a different org and scopes the lookup predicate", async () => {
    const findFirst = jest.fn().mockResolvedValue(undefined);
    const service = new HrLeaveBlackoutService(
      { query: { leaveBlackoutDates: { findFirst } } } as never,
    );

    await expect(service.getById("org-b", 84)).resolves.toBeNull();

    expect(sqlValues(findFirst.mock.calls[0]?.[0]?.where)).toEqual(
      expect.arrayContaining([84, "org-b"]),
    );
  });

  it("does not delete a blackout date owned by a different org", async () => {
    const where = jest.fn().mockResolvedValue(undefined);
    const service = new HrLeaveBlackoutService(
      { delete: jest.fn().mockReturnValue({ where }) } as never,
    );

    await expect(service.remove("org-b", 84)).resolves.toEqual({ success: true });

    expect(sqlValues(where.mock.calls[0]?.[0])).toEqual(expect.arrayContaining([84, "org-b"]));
  });
});
