import { HrAnalyticsPlusService } from "../../hr-analytics-plus.service";

function createExecuteDb(results: unknown[][]) {
  let call = 0;
  return {
    execute: jest.fn().mockImplementation(() => {
      const rows = results[call] ?? [];
      call += 1;
      return Promise.resolve(rows);
    }),
  };
}

function createService(db: unknown): HrAnalyticsPlusService {
  const instance = Object.create(HrAnalyticsPlusService.prototype) as HrAnalyticsPlusService;
  Reflect.set(instance, "db", db);
  return instance;
}

describe("workforce analytics response contracts", () => {
  it("attrition forecast returns rate/projectedRate fields the chart renders", async () => {
    const db = createExecuteDb([
      [
        { month: "2026-05", exits: "2" },
        { month: "2026-06", exits: "4" },
      ],
      [{ active: "60" }],
    ]);
    const service = createService(db);

    const result = await service.getAttritionForecast("org-1");
    expect(result.historical).toEqual([
      { month: "2026-05", exits: 2, rate: 3.3 },
      { month: "2026-06", exits: 4, rate: 6.7 },
    ]);
    expect(result.forecast).toHaveLength(6);
    expect(result.forecast[0]).toMatchObject({ projectedExits: 3, projectedRate: 5 });
    expect(result.disclaimer).toMatch(/not a prediction/i);
  });

  it("attrition forecast returns empty arrays with an explanatory disclaimer when no history exists", async () => {
    const db = createExecuteDb([[], [{ active: "10" }]]);
    const service = createService(db);

    const result = await service.getAttritionForecast("org-1");
    expect(result.historical).toEqual([]);
    expect(result.forecast).toEqual([]);
    expect(result.disclaimer).toMatch(/no employee exits/i);
  });

  it("succession risk maps snake_case rows to the riskyRoles contract", async () => {
    const db = createExecuteDb([
      [
        {
          id: "3",
          role_name: "Head of Finance",
          incumbent_id: "user-9",
          readiness: "1_2_years",
          has_successor: false,
          note: null,
        },
      ],
    ]);
    const service = createService(db);

    const result = await service.getSuccessionRisk("org-1");
    expect(result.riskyRoles).toEqual([
      {
        id: 3,
        roleName: "Head of Finance",
        incumbentId: "user-9",
        readiness: "1_2_years",
        hasSuccessor: false,
        note: null,
      },
    ]);
  });

  it("skills gap maps counts to numbers with a non-negative gap", async () => {
    const db = createExecuteDb([
      [{ skill_name: "React", required_count: "5", covered_count: "7" }],
    ]);
    const service = createService(db);

    const result = await service.getSkillsGap("org-1");
    expect(result.gaps).toEqual([{ skillName: "React", required: 5, covered: 7, gap: 0 }]);
  });

  it("budget vs actual returns a flat camelCase array with variance", async () => {
    const db = createExecuteDb([
      [
        {
          id: "11",
          fiscal_year: "2026",
          department_id: "4",
          department_name: "Engineering",
          budgeted_headcount: "20",
          budgeted_cost_cents: "100000",
          actual_headcount: "17",
        },
      ],
    ]);
    const service = createService(db);

    const result = await service.getBudgetVsActual("org-1");
    expect(result).toEqual([
      {
        planId: 11,
        fiscalYear: 2026,
        departmentId: "4",
        departmentName: "Engineering",
        budgeted: 20,
        actual: 17,
        variance: -3,
      },
    ]);
  });
});
