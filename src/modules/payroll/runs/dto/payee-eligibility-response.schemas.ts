import { z } from "zod";

const personEmploymentSchema = z.object({
  employmentId: z.number().int(),
  employeeNumber: z.string(),
  lifecycleStatus: z.string(),
});

export const payeeEligibilityResponseSchema = z.object({
  organizationPersonId: z.string(),
  payable: z.boolean(),
  payableAs: z.enum(["user", "worker"]).nullable(),
  payeeUserId: z.string().nullable(),
  payeeWorkerId: z.string().nullable(),
  resolvedVia: z.enum(["membership", "payee-worker", "person-record"]).nullable(),
  employment: personEmploymentSchema.nullable(),
  reason: z.enum(["payable", "employed-but-not-payable", "not-payable"]),
});
