import { z } from "zod";

export const setupSchema = z.object({
  companyName: z.string().min(1, "Company name is required"),
  industry: z.string().min(1, "Industry is required"),
  companySize: z.string().min(1, "Company size is required"),
  country: z.string().min(1, "Country is required"),
  website: z.string().url().optional().or(z.literal("")),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  jobTitle: z.string().min(1, "Job title is required"),
  phone: z.string().optional(),
  logo: z.string().url().optional().or(z.literal("")),
  primaryColor: z.string().optional(),
  supportEmail: z.string().email().optional().or(z.literal("")),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  language: z.string().optional(),
  fiscalYearStart: z.coerce.number().int().min(1).max(12).optional(),
  businessHours: z.record(z.object({ open: z.string(), close: z.string(), enabled: z.boolean() })).optional(),
  invitees: z.array(z.object({ email: z.string().email(), role: z.string() })).optional(),
  enabledModules: z.array(z.string()).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
