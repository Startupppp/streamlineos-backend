import { z } from "zod";

export const setupSchema = z.object({
  companyName: z.string().optional(),
  industry: z.string().min(1, "Industry is required"),
  companySize: z.string().min(1, "Company size is required"),
  country: z.string().min(1, "Country is required"),
  website: z.string().url().optional().or(z.literal("")),
  firstName: z.string().optional().default(""),
  lastName: z.string().optional().default(""),
  jobTitle: z.string().optional().default(""),
  phone: z.string().optional(),
  logo: z.string().url().optional().or(z.literal("")),
  primaryColor: z.string().optional(),
  supportEmail: z.string().email().optional().or(z.literal("")),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  language: z.string().optional(),
  fiscalYearStart: z.coerce.number().int().min(1).max(12).optional(),
  businessHours: z.record(z.string(), z.object({ open: z.string(), close: z.string(), enabled: z.boolean() })).optional(),
  holidays: z.array(z.object({ name: z.string().min(1), date: z.string().min(1) })).optional(),
  invitees: z.array(z.object({ email: z.string().email(), role: z.string() })).optional(),
  enabledModules: z.array(z.string()).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
