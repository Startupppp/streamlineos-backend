import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";

const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: pageSizeField(20, 100),
});

export const simulatePolicySchema = z.object({
  employeeId: z.string().uuid(),
  policyType: z.string().min(1),
  hypotheticalContext: z.record(z.string(), z.unknown()),
});

export const simulateLeaveBalanceSchema = z.object({
  employeeId: z.string().uuid(),
  leaveTypeId: z.number().int().positive(),
  hypotheticalAccrualRate: z.number().optional(),
  projectionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "projectionDate must be YYYY-MM-DD"),
});

export const simulateApprovalRoutingSchema = z.object({
  objectType: z.string().min(1),
  hypotheticalContext: z.record(z.string(), z.unknown()),
  employeeId: z.string().uuid(),
});

export const simulatePayrollImpactSchema = z.object({
  employeeId: z.string().uuid(),
  hypotheticalComponents: z.array(z.object({
    name: z.string(),
    amount: z.number(),
    type: z.enum(["earning", "deduction"]),
  })),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "effectiveDate must be YYYY-MM-DD"),
});

export const compareSchema = z.object({
  employeeId: z.string().uuid(),
  oldPolicyId: z.coerce.number().int().positive(),
  newPolicyId: z.coerce.number().int().positive(),
  policyType: z.string().min(1),
});

export const listSimulationsSchema = paginationSchema.extend({
  type: z.enum(["policy", "leave", "attendance", "approval", "payroll"]).optional(),
});

export type SimulatePolicyInput = z.infer<typeof simulatePolicySchema>;
export type SimulateLeaveBalanceInput = z.infer<typeof simulateLeaveBalanceSchema>;
export type SimulateApprovalRoutingInput = z.infer<typeof simulateApprovalRoutingSchema>;
export type SimulatePayrollImpactInput = z.infer<typeof simulatePayrollImpactSchema>;
export type CompareInput = z.infer<typeof compareSchema>;
export type ListSimulationsInput = z.infer<typeof listSimulationsSchema>;
