import type { Db } from "../../../../db/drizzle.module";
import { EssService } from "../ess.service";
import type { TaxService } from "../../hr-payroll/tax.service";
import { essSalaryStructureSchema } from "../dto/ess-response.schemas";

function makeService(profileRow: Record<string, unknown> | undefined, componentRows: unknown[]) {
  const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(componentRows) });
  const innerJoin = jest.fn().mockReturnValue({ where });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const db = {
    query: {
      payrollPolicies: { findFirst: jest.fn().mockResolvedValue(undefined) },
      employeeSalaryProfiles: { findFirst: jest.fn().mockResolvedValue(profileRow) },
    },
    select: jest.fn().mockReturnValue({ from }),
  } as unknown as Db;
  return new EssService(db, {} as unknown as TaxService);
}

describe("GET /payroll/me/salary-structure when no active profile exists", () => {
  it("answers setupRequired instead of 404, so the self-service page renders a setup state rather than the route error boundary", async () => {
    const service = makeService(undefined, []);

    const result = await service.getSalaryStructure("org-1", "user-1", 42);

    expect(result).toEqual({
      setupRequired: true,
      profile: null,
      components: [],
      message: expect.stringContaining("not been configured"),
    });
    expect(essSalaryStructureSchema.safeParse(result).success).toBe(true);
  });

  it("answers the configured structure with setupRequired false", async () => {
    const service = makeService(
      {
        id: 9,
        annualCtc: "1200000.00",
        workerType: "EMPLOYEE",
        taxRegime: "NEW",
        costCenter: null,
        effectiveFrom: "2026-04-01",
      },
      [{ code: "BASIC", name: "Basic", type: "EARNING", amount: "50000.00", percent: null }],
    );

    const result = await service.getSalaryStructure("org-1", "user-1", 42);

    expect(result.setupRequired).toBe(false);
    expect(result.components).toHaveLength(1);
    expect(essSalaryStructureSchema.safeParse(result).success).toBe(true);
  });
});
