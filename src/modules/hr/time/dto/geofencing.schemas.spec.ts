import { createZoneSchema } from "./geofencing.schemas";

describe("a geofence zone is created from a real coordinate pair", () => {
  it("accepts decimal-string coordinates within range", () => {
    expect(createZoneSchema.safeParse({ name: "HQ", lat: "13.0827", lng: "80.2707" }).success).toBe(true);
  });

  it("refuses text that the numeric columns would reject with a 500", () => {
    const result = createZoneSchema.safeParse({ name: "HQ", lat: "north", lng: "80.2707" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(["Coordinate must be a number"]);
  });

  it("refuses a latitude past the poles or a longitude past the antimeridian", () => {
    expect(createZoneSchema.safeParse({ name: "HQ", lat: "90.5", lng: "0" }).success).toBe(false);
    expect(createZoneSchema.safeParse({ name: "HQ", lat: "0", lng: "-180.1" }).success).toBe(false);
  });
});
