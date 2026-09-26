import { DB_ENUMS } from "../../../../db/enums.generated";
import {
  runListItemSchema,
  payrollRunSchema,
  runEmployeeListItemSchema,
  runEmployeeDetailSchema,
} from "./runs-response.schemas";

describe("runs-response.schemas — enum drift guard", () => {
  describe("payroll run status vs payroll_run_status pgEnum", () => {
    it("rejects a payroll run status the payroll_run_status pgEnum does not declare, which z.string() accepted", () => {
      expect(() =>
        runListItemSchema.parse({
          id: 1,
          month: "2025-01",
          status: "NONSENSE_STATUS",
          runType: "REGULAR",
          entityId: null,
          statutoryRuleVersion: null,
          grossTotal: null,
          netTotal: null,
          employeeCount: null,
          exceptionCount: null,
          createdAt: new Date().toISOString(),
        }),
      ).toThrow();
    });

    it("runListItemSchema and payrollRunSchema disagree on status type — list is z.string(), detail is z.enum — same column must use the same type", () => {
      const listOptions = (runListItemSchema.shape.status as { options?: unknown }).options;
      const detailOptions = (payrollRunSchema.shape.status as { options?: unknown }).options;
      expect(listOptions).toBeDefined();
      expect(listOptions).toEqual(detailOptions);
    });

    it("runListItemSchema.status member set equals DB_ENUMS.payroll_run_status exactly so a future pgEnum change cannot drift again", () => {
      const options = (runListItemSchema.shape.status as { options?: unknown[] }).options;
      expect(options).toBeDefined();
      expect([...(options ?? [])]).toEqual([...DB_ENUMS.payroll_run_status]);
    });

    it("payrollRunSchema.status member set equals DB_ENUMS.payroll_run_status exactly so a future pgEnum change cannot drift again", () => {
      const options = payrollRunSchema.shape.status.options;
      expect([...options]).toEqual([...DB_ENUMS.payroll_run_status]);
    });
  });

  describe("workerType vs payroll_worker_type pgEnum", () => {
    it("runEmployeeListItemSchema rejects a workerType the payroll_worker_type pgEnum does not declare, which z.string() accepted", () => {
      expect(() =>
        runEmployeeListItemSchema.parse({
          id: 1,
          userId: "u1",
          workerType: "SEASONAL",
          currency: "INR",
          gross: "100000",
          totalDeductions: "10000",
          net: "90000",
          status: "ACTIVE",
          holdReason: null,
          userName: null,
          userEmail: "test@example.com",
        }),
      ).toThrow();
    });

    it("runEmployeeListItemSchema.workerType member set equals DB_ENUMS.payroll_worker_type exactly so a future pgEnum change cannot drift again", () => {
      const options = (runEmployeeListItemSchema.shape.workerType as { options?: unknown[] }).options;
      expect(options).toBeDefined();
      expect([...(options ?? [])]).toEqual([...DB_ENUMS.payroll_worker_type]);
    });

    it("runEmployeeDetailSchema.workerType member set equals DB_ENUMS.payroll_worker_type exactly so a future pgEnum change cannot drift again", () => {
      const options = (runEmployeeDetailSchema.shape.workerType as { options?: unknown[] }).options;
      expect(options).toBeDefined();
      expect([...(options ?? [])]).toEqual([...DB_ENUMS.payroll_worker_type]);
    });
  });
});
