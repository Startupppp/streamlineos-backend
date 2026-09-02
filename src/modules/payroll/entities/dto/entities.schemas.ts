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
