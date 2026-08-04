import { z } from "zod";
import { ORG_MODULE_KEYS } from "../../setup/dto/org.schemas";

export const generateSchema = z
  .object({
    industry: z.string().trim().min(1).max(100),
    enabledModules: z.array(z.enum(ORG_MODULE_KEYS)).max(50).optional(),
  })
  .strict();

export type GenerateInput = z.infer<typeof generateSchema>;
