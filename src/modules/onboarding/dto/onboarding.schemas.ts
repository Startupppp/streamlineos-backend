import { z } from "zod";

const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;

const dateOfBirthSchema = z
  .string()
  .refine((val) => !Number.isNaN(Date.parse(val)), "Invalid date of birth")
  .refine((val) => new Date(val).getTime() <= Date.now(), "Date of birth cannot be in the future")
  .refine((val) => {
    const ageYears = (Date.now() - new Date(val).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return ageYears >= 14 && ageYears <= 100;
  }, "Date of birth must correspond to an age between 14 and 100");

export const initiateSchema = z.object({
  userId: z.string().min(1),
});

export const personalDetailsSchema = z
  .object({
    phone: z.string().regex(PHONE_REGEX, "Enter a valid phone number"),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
    dateOfBirth: dateOfBirthSchema,
    emergencyName: z.string().min(2, "Emergency contact name is required"),
    emergencyRelation: z.string().min(2, "Relationship is required"),
    emergencyPhone: z.string().regex(PHONE_REGEX, "Enter a valid phone number"),
    addressLine1: z.string().optional(),
    addressCity: z.string().optional(),
    addressState: z.string().optional(),
    addressPostalCode: z.string().optional(),
    addressCountry: z.string().optional(),
  })
  .refine((val) => val.phone !== val.emergencyPhone, {
    message: "Emergency contact phone number must be different from your own phone number",
    path: ["emergencyPhone"],
  });

const BANK_NAME_REGEX = /^[A-Za-z][A-Za-z0-9.,'&()\-\s]*$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const SSN_REGEX = /^\d{3}-?\d{2}-?\d{4}$/;

export const bankDetailsSchema = z.object({
  accountHolder: z.string().min(2, "Account holder name is required").max(100),
  bankName: z
    .string()
    .min(2, "Bank name is required")
    .max(100)
    .regex(BANK_NAME_REGEX, "Enter a valid bank name"),
  accountNumber: z
    .string()
    .min(8)
    .max(18)
    .regex(/^\d+$/, "Account number must contain only digits"),
  ifsc: z.string().length(11).regex(IFSC_REGEX, "Enter a valid IFSC code"),
  branch: z.string().optional(),
  taxId: z
    .string()
    .optional()
    .refine(
      (val) => !val || PAN_REGEX.test(val.toUpperCase()) || SSN_REGEX.test(val),
      "Enter a valid PAN or SSN",
    ),
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

export const updateTaskSchema = z.object({
  status: z.enum(["COMPLETED", "PENDING"]),
});

export type InitiateInput = z.infer<typeof initiateSchema>;
export type PersonalDetailsInput = z.infer<typeof personalDetailsSchema>;
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
