import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

export const payrollEntitySchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  legalName: z.string(),
  countryCode: z.string(),
  stateCode: z.string().nullable(),
  baseCurrency: z.string(),
  pan: z.string().nullable(),
  tan: z.string().nullable(),
  pfEstablishmentCode: z.string().nullable(),
  esiCode: z.string().nullable(),
  ptStateCode: z.string().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const payrollEntityListResponseSchema = z.array(payrollEntitySchema);

const countryPackDescriptorSchema = z.object({
  countryCode: z.string(),
  countryName: z.string(),
  currency: z.string(),
  maturity: z.enum(["production_baseline", "pilot", "template"]),
  honestyLabel: z.string(),
  payrollStatutoryBundle: z.string().nullable(),
  holidayCount: z.number().int(),
  complianceRequirementCount: z.number().int(),
  sensitiveFieldCount: z.number().int(),
});

export const countryPacksResponseSchema = z.object({
  mode: z.literal("country_pack_catalog"),
  honestyNote: z.string(),
  packs: z.array(countryPackDescriptorSchema),
});

const entityReadinessItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  done: z.boolean(),
  detail: z.string(),
});

export const entityContextResponseSchema = z.object({
  entity: payrollEntitySchema,
  countryPack: countryPackDescriptorSchema.nullable(),
  readiness: z.array(entityReadinessItemSchema),
  readinessScore: z.number(),
  isolation: z.object({ note: z.string() }),
  honestyNote: z.string(),
});
