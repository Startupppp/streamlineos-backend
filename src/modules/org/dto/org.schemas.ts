import { z } from "zod";

// Uppercase org-module vocabulary stored in organizations.enabled_modules (see EntitlementsService MODULE_KEY_TO_ORG_MODULE).
export const ORG_MODULE_KEYS = [
  "HR",
  "CRM",
  "PROJECTS",
  "FINANCE",
  "INVENTORY",
  "HELPDESK",
  "SURVEYS",
  "PAYROLL",
  "SIGN",
  "CHAT",
  "KNOWLEDGE",
] as const;

// Completing requires the user's real setup data — only skip creates a default workspace.
export const setupSchema = z.object({
  companyName: z.string().max(200).optional(),
  industry: z.string().min(1, "Industry is required").max(100),
  companySize: z.string().min(1, "Company size is required").max(50),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  phone: z.string().max(32).optional(),
  enabledModules: z
    .array(z.enum(ORG_MODULE_KEYS))
    .min(1, "At least one module is required")
    .max(50),
});

export type SetupInput = z.infer<typeof setupSchema>;
