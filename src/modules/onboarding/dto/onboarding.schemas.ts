import { z } from "zod";

export const initiateSchema = z.object({
  userId: z.string().min(1),
});

export const personalDetailsSchema = z.object({
  phone: z.string().min(1),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
  dateOfBirth: z.string().optional(),
  experienceYears: z.string().optional(),
  skills: z.array(z.string()).or(z.string()).optional(),
});

export const bankDetailsSchema = z.object({
  accountHolder: z.string().min(1),
  bankName: z.string().min(1),
  accountNumber: z.string().min(8).max(18),
  ifsc: z.string().length(11),
  branch: z.string().optional(),
  taxId: z.string().optional(),
});

export const templateStepSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  ownerRole: z.string().default("NEW_HIRE"),
  dueOffsetDays: z.number().int().min(0).default(0),
  isRequired: z.boolean().default(true),
  isComplianceItem: z.boolean().default(false),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1),
  departmentId: z.number().int().optional(),
  description: z.string().optional(),
  steps: z.array(templateStepSchema).default([]),
});

export type InitiateInput = z.infer<typeof initiateSchema>;
export type PersonalDetailsInput = z.infer<typeof personalDetailsSchema>;
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
