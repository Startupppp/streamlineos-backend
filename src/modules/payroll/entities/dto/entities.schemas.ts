import { z } from "zod";

export const createEntitySchema = z.object({
  legalName: z.string().min(1).max(200),
  countryCode: z.string().length(2).optional(),
  stateCode: z.string().max(10).optional(),
  baseCurrency: z.string().length(3).optional(),
  pan: z.string().max(20).optional(),
  tan: z.string().max(20).optional(),
  pfEstablishmentCode: z.string().max(50).optional(),
  esiCode: z.string().max(50).optional(),
  ptStateCode: z.string().max(10).optional(),
}).strict();
export type CreateEntityInput = z.infer<typeof createEntitySchema>;

export const updateEntitySchema = z.object({
  legalName: z.string().trim().min(1).max(200).optional(),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must look like ABCDE1234F").nullable().optional(),
  tan: z.string().regex(/^[A-Z]{4}[0-9]{5}[A-Z]$/, "TAN must look like ABCD12345E").nullable().optional(),
  pfEstablishmentCode: z.string().regex(/^[A-Z0-9]{5,22}$/, "PF establishment code must be 5-22 uppercase letters or digits").nullable().optional(),
  esiCode: z.string().regex(/^[0-9]{17}$/, "ESI code must be 17 digits").nullable().optional(),
  ptStateCode: z.string().regex(/^[A-Z]{2}$/, "PT state code must be two uppercase letters").nullable().optional(),
  stateCode: z.string().regex(/^[A-Z]{2}$/, "State code must be two uppercase letters").nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: "Provide at least one field to update" });
export type UpdateEntityInput = z.infer<typeof updateEntitySchema>;
