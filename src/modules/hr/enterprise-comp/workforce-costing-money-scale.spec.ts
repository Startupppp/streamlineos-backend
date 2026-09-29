import type { Db } from "../../../db/drizzle.module";
import { WorkforceCostingService } from "./workforce-costing.service";

function sqlText(value: unknown, seen = new Set<object>()): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  const chunks = Reflect.get(value, "queryChunks");
  const parts: unknown[] = Array.isArray(chunks) ? chunks : Object.values(value);
  return parts.map((part) => sqlText(part, seen)).join("");
}

function makeDb(rows: unknown[]) {
  const execute = jest.fn().mockResolvedValue(rows);
  const db = { execute } as unknown as Db;
  return { db, execute };
}

function executedSql(execute: jest.Mock): string {
  return sqlText(execute.mock.calls[0]?.[0]);
}

const ORG = "org-1";

describe("workforce costing reports annual_ctc in the unit its field names promise", () => {
  it("scales the org summary by 100, because annual_ctc is decimal major units and the field is named totalAnnualCtcCents", async () => {
    const { db, execute } = makeDb([
      { total_headcount: "2", total_annual_ctc_cents: "240000000", total_monthly_cost_cents: "20000000" },
    ]);

    const summary = await new WorkforceCostingService(db).costSummary(ORG);

    expect(executedSql(execute)).toContain("annual_ctc * 100");
    expect(summary).toEqual({
      totalHeadcount: 2,
      totalAnnualCtcCents: 240000000,
      totalMonthlyCostCents: 20000000,
    });
  });

  it("never sums annual_ctc unscaled, which understated every cost figure by 100x once the frontend divided by 100", async () => {
    const { db, execute } = makeDb([{}]);

    await new WorkforceCostingService(db).costSummary(ORG);

    expect(executedSql(execute)).not.toContain("CAST(annual_ctc AS BIGINT)");
  });

  it("scales the per-department monthly cost by 100 and still scopes to the caller's org", async () => {
    const { db, execute } = makeDb([
      { department_id: "d1", department_name: "Engineering", headcount: "3", monthly_cost_cents: "30000000" },
    ]);

    const rows = await new WorkforceCostingService(db).costByDepartment(ORG, "2026-09");

    expect(executedSql(execute)).toContain("esp.annual_ctc * 100");
    expect(rows).toEqual([
      { departmentId: "d1", departmentName: "Engineering", headcount: 3, monthlyCostCents: 30000000 },
    ]);
  });

  it("scales the per-location monthly cost by 100", async () => {
    const { db, execute } = makeDb([
      { location_id: "unassigned", headcount: "1", monthly_cost_cents: "10000000" },
    ]);

    const rows = await new WorkforceCostingService(db).costByLocation(ORG);

    expect(executedSql(execute)).toContain("esp.annual_ctc * 100");
    expect(rows).toEqual([
      { locationId: "unassigned", headcount: 1, monthlyCostCents: 10000000 },
    ]);
  });

  it("reports zeros rather than NaN for an org with no active salary profile", async () => {
    const { db } = makeDb([{ total_headcount: "0", total_annual_ctc_cents: null, total_monthly_cost_cents: null }]);

    await expect(new WorkforceCostingService(db).costSummary(ORG)).resolves.toEqual({
      totalHeadcount: 0,
      totalAnnualCtcCents: 0,
      totalMonthlyCostCents: 0,
    });
  });

  it("leaves forecastedCost alone, because hr_comp_recommendations already stores cents", async () => {
    const execute = jest.fn().mockResolvedValue([
      { total_current: "100", total_forecasted: "150", headcount: "1" },
    ]);
    const builder = {
      from: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue([{ budgetPoolCents: 500, fiscalYear: 2026 }]),
    };
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    const db = { execute, select: jest.fn().mockReturnValue(builder) } as unknown as Db;

    const forecast = await new WorkforceCostingService(db).forecastedCost(ORG, 7);

    expect(sqlText(execute.mock.calls[0]?.[0])).not.toContain("* 100");
    expect(forecast).toMatchObject({
      totalCurrentAnnualCents: 100,
      totalForecastedAnnualCents: 150,
      totalIncreaseCents: 50,
    });
  });
});
