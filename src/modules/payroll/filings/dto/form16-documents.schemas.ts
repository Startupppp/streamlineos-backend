import { z } from "zod";
import { nullableWireDate } from "../../../../common/openapi/wire-types";
import { isFinancialYear } from "../lib/form16-documents";

export const financialYearSchema = z
  .string()
  .refine(isFinancialYear, "Financial year must look like 2025-26");

export const form16ListQuerySchema = z.object({ financialYear: financialYearSchema }).strict();
export type Form16ListQuery = z.infer<typeof form16ListQuerySchema>;

export const form16FyParamsSchema = z.object({ financialYear: financialYearSchema }).strict();

export const form16MemberParamsSchema = z
  .object({
    financialYear: financialYearSchema,
    membershipId: z.coerce.number().int().positive(),
  })
  .strict();

export const form16StatusSchema = z.enum(["missing", "uploaded", "released"]);

export const form16RowSchema = z.object({
  userMembershipId: z.number().int(),
  employeeName: z.string().nullable(),
  email: z.string().nullable(),
  status: form16StatusSchema,
  fileName: z.string().nullable(),
  fileSizeBytes: z.number().int().nullable(),
  uploadedAt: nullableWireDate(),
  releasedAt: nullableWireDate(),
});

export const form16ListResponseSchema = z.object({
  financialYear: z.string(),
  rows: z.array(form16RowSchema),
  counts: z.object({
    missing: z.number().int(),
    uploaded: z.number().int(),
    released: z.number().int(),
  }),
});

export const form16ReleaseAllResponseSchema = z.object({
  financialYear: z.string(),
  released: z.number().int(),
});

export const essForm16ListResponseSchema = z.object({
  documents: z.array(
    z.object({
      financialYear: z.string(),
      fileName: z.string(),
      releasedAt: nullableWireDate(),
    }),
  ),
});
