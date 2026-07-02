import { z } from "zod";

export const setupSchema = z.object({
  companyName: z.string().optional(),
  industry: z.string().min(1, "Industry is required"),
  companySize: z.string().min(1, "Company size is required"),
  country: z.string().optional(),
  timezone: z.string().optional(),
  enabledModules: z.array(z.string()).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
