import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { stubService } from "../../test/service-stub.spec-fixtures";
import type { PlanLimitsService } from "../billing/core/plan-limits.service";
import type { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { CrmService } from "./crm.service";

describe("CrmService — cross-tenant isolation", () => {
  const VALID_TOKEN = "tok-valid";
  const INVALID_TOKEN = "tok-invalid";

  function makeDb(surveyRow: unknown): Db {
    const where = jest.fn().mockResolvedValue(surveyRow ? [surveyRow] : []);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return {
      select,
      query: { webLeadForms: { findFirst: jest.fn().mockResolvedValue(null) } },
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }),
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("throws NotFoundException for an invalid public token (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const mockPlanLimits = stubService<PlanLimitsService>({ assertWithinLimit: jest.fn() });
    const svc = new CrmService(db, mockBus, mockPlanLimits);
    await expect(svc.getSurvey(INVALID_TOKEN)).rejects.toThrow(NotFoundException);
  });

  it("returns survey for a valid token (control — correct token)", async () => {
    const db = makeDb({ title: "NPS", question: "Rate us", status: "active" });
    const mockBus = stubService<CrmAutomationBusService>({ emit: jest.fn() });
    const mockPlanLimits = stubService<PlanLimitsService>({ assertWithinLimit: jest.fn() });
    const svc = new CrmService(db, mockBus, mockPlanLimits);
    const result = await svc.getSurvey(VALID_TOKEN);
    expect(result.survey).toHaveProperty("title");
  });
});
