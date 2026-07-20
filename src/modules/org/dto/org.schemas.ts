import { z } from "zod";

// All fields optional so partial onboarding still completes; the service fills
// sensible defaults (industry/companySize/modules) for anything not provided.
export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  industry: z.string().max(100).optional(),
  companySize: z.string().max(50).optional(),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  enabledModules: z.array(z.string().max(50)).max(50).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
