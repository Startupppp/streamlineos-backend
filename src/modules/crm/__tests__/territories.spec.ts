import { TerritoryMatchService } from "../territory-match.service";
import { DRIZZLE } from "../../../db/drizzle.constants";

function makeDbWithTerritories(rows: unknown[]) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  };
}

describe("TerritoryMatchService", () => {
  it("matches a territory by country criteria", async () => {
    const mockDb = makeDbWithTerritories([
      {
        id: 1,
        name: "India",
        priority: 10,
        assignedReps: [101],
        criteria: { countries: ["India"] },
      },
    ]);

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "India" });

    expect(result).not.toBeNull();
    expect(result?.territory.id).toBe(1);
    expect(result?.assignedReps).toEqual([101]);
  });

  it("does not match when one dimension fails", async () => {
    const mockDb = makeDbWithTerritories([
      {
        id: 2,
        name: "Mumbai",
        priority: 5,
        assignedReps: [102],
        criteria: { countries: ["India"], cities: ["Mumbai"] },
      },
    ]);

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "India", city: "Delhi" });

    expect(result).toBeNull();
  });

  it("picks highest-priority territory when multiple match", async () => {
    const mockDb = makeDbWithTerritories([
      {
        id: 10,
        name: "High Priority",
        priority: 100,
        assignedReps: [201],
        criteria: { countries: ["USA"] },
      },
      {
        id: 11,
        name: "Low Priority",
        priority: 1,
        assignedReps: [202],
        criteria: { countries: ["USA"] },
      },
    ]);

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "USA" });

    expect(result?.territory.id).toBe(10);
    expect(result?.assignedReps).toEqual([201]);
  });

  it("returns null when no territories are active", async () => {
    const mockDb = makeDbWithTerritories([]);

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "Germany" });

    expect(result).toBeNull();
  });
});
