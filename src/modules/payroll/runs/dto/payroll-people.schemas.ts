import { z } from "zod";
import { pageSizeField } from "../../../../common/pagination/list-query.schema";
import { cursorPageSchema } from "../../../../common/openapi/response-envelopes";

export const listPayrollPeopleQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(2048).optional(),
    limit: pageSizeField(50, 100),
    search: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ListPayrollPeopleQuery = z.infer<typeof listPayrollPeopleQuerySchema>;

export const payrollPersonPayeeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: z.string() }).strict(),
    z.object({ kind: z.literal("worker"), workerId: z.string() }).strict(),
  ])
  .nullable();

export const payrollPersonSchema = z
  .object({
    organizationPersonId: z.string().nullable(),
    displayName: z.string(),
    email: z.string().nullable(),
    employeeNumber: z.string().nullable(),
    payee: payrollPersonPayeeSchema,
    hasSalaryProfile: z.boolean(),
    eligibility: z.enum(["eligible", "has-salary", "needs-payee-link", "exited"]),
  })
  .strict();

export const payrollPeopleListResponseSchema = cursorPageSchema(payrollPersonSchema);

export const payrollPeopleReadinessSchema = z
  .object({
    payable: z.number().int(),
    withSalary: z.number().int(),
    payableWithoutSalary: z.number().int(),
    needsPayeeLink: z.number().int(),
    payableWithoutSalarySample: z.array(
      z
        .object({
          organizationPersonId: z.string().nullable(),
          displayName: z.string(),
          payee: payrollPersonPayeeSchema,
        })
        .strict(),
    ),
  })
  .strict();
