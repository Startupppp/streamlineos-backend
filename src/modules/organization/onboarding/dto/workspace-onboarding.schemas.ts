import { z } from "zod";
import { ORG_MODULE_KEYS } from "../../setup/dto/org.schemas";

export const generateSchema = z
  .object({
    industry: z.string().trim().min(1).max(100),
    enabledModules: z.array(z.enum(ORG_MODULE_KEYS)).max(50).optional(),
  })
  .strict();

export type GenerateInput = z.infer<typeof generateSchema>;

export const generateWorkspaceResponseSchema = z.object({
  businessUnits: z.number().int().nonnegative(),
  branches: z.number().int().nonnegative(),
  departments: z.number().int().nonnegative(),
  teams: z.number().int().nonnegative(),
});

export type GenerateWorkspaceResponse = z.infer<typeof generateWorkspaceResponseSchema>;
