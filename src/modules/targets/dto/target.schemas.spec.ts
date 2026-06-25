import { listSchema, createSchema, updateSchema, leaderboardSchema } from "./target.schemas";

describe("target schemas", () => {
  it("listSchema coerces limit/offset and enforces bounds", () => {
    expect(listSchema.parse({ userId: "u1", period: "daily", limit: "50", offset: "10" })).toMatchObject({
      userId: "u1",
      period: "daily",
      limit: 50,
      offset: 10,
    });
    expect(() => listSchema.parse({ limit: "500" })).toThrow();
    expect(() => listSchema.parse({ offset: "-1" })).toThrow();
  });

  it("createSchema requires metricType/targetValue/startDate/endDate and defaults period to daily", () => {
    expect(
      createSchema.parse({
        userId: "u1",
        metricType: "revenue",
        targetValue: "1000",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    ).toMatchObject({ period: "daily" });
    expect(() => createSchema.parse({ metricType: "revenue" })).toThrow();
  });

  it("createSchema accepts userIds array", () => {
    expect(
      createSchema.parse({
        userIds: ["a", "b"],
        metricType: "revenue",
        targetValue: "1000",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }).userIds,
    ).toEqual(["a", "b"]);
  });

  it("updateSchema is all-optional", () => {
    expect(updateSchema.parse({})).toEqual({});
    expect(updateSchema.parse({ targetValue: "5", currentValue: "2", notes: "x" })).toMatchObject({
      targetValue: "5",
    });
  });

  it("leaderboardSchema accepts optional metricType", () => {
    expect(leaderboardSchema.parse({})).toEqual({});
    expect(leaderboardSchema.parse({ metricType: "revenue" }).metricType).toBe("revenue");
  });
});
