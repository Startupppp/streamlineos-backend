import { z } from "zod";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
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
  projectionDate: z.string(),
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
  effectiveDate: z.string(),
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
