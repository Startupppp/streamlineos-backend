import { TerritoryMatchService } from "../territory-match.service";

type TerritoryRow = {
  id: number;
  name: string;
  priority: number;
  criteria: Record<string, unknown>;
};

type RepRow = {
  territoryId: number;
  crmPersonId: number;
};

function makeDbWithTerritories(rows: TerritoryRow[], reps: RepRow[] = []) {
  return {
    select: jest.fn()
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      })
      .mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(reps),
        }),
      }),
  };
}

describe("TerritoryMatchService", () => {
  it("matches a territory by country criteria", async () => {
    const mockDb = makeDbWithTerritories(
      [{ id: 1, name: "India", priority: 10, criteria: { countries: ["India"] } }],
      [{ territoryId: 1, crmPersonId: 101 }],
    );

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "India" });

    expect(result).not.toBeNull();
    expect(result?.territory.id).toBe(1);
    expect(result?.assignedReps).toEqual([101]);
  });

  it("does not match when one dimension fails", async () => {
    const mockDb = makeDbWithTerritories(
      [{ id: 2, name: "Mumbai", priority: 5, criteria: { countries: ["India"], cities: ["Mumbai"] } }],
      [{ territoryId: 2, crmPersonId: 102 }],
    );

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "India", city: "Delhi" });

    expect(result).toBeNull();
  });

  it("picks highest-priority territory when multiple match", async () => {
    const mockDb = makeDbWithTerritories(
      [
        { id: 10, name: "High Priority", priority: 100, criteria: { countries: ["USA"] } },
        { id: 11, name: "Low Priority", priority: 1, criteria: { countries: ["USA"] } },
      ],
      [
        { territoryId: 10, crmPersonId: 201 },
        { territoryId: 11, crmPersonId: 202 },
      ],
    );

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "USA" });

    expect(result?.territory.id).toBe(10);
    expect(result?.assignedReps).toEqual([201]);
  });

  it("returns null when no territories are active", async () => {
    const mockDb = makeDbWithTerritories([], []);

    const service = new TerritoryMatchService(mockDb as never);
    const result = await service.match("org1", { country: "Germany" });

    expect(result).toBeNull();
  });
});
