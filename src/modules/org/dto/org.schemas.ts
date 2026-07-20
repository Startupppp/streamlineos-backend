import { z } from "zod";

// Completing requires the user's real setup data — only skip creates a default workspace.
export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  industry: z.string().min(1, "Industry is required").max(100),
  companySize: z.string().min(1, "Company size is required").max(50),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  enabledModules: z.array(z.string().max(50)).max(50).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
