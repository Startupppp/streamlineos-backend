import { z } from "zod";

export const installAppSchema = z.object({
  appId: z.coerce.number().int().positive(),
});

export const startTrialSchema = z.object({
  appId: z.coerce.number().int().positive(),
});
