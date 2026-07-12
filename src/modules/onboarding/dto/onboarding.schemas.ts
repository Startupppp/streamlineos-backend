import { z } from "zod";

const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;
const PERSON_NAME_REGEX = /^[A-Za-z][A-Za-z\s'.-]{1,79}$/;
const STREET_ADDRESS_REGEX = /^[A-Za-z0-9][A-Za-z0-9\s.,#/-]{2,119}$/;
const INDIAN_PINCODE_REGEX = /^[1-9][0-9]{5}$/;
const INDIA_COUNTRY_NAME = "India";

const EMERGENCY_RELATIONSHIPS = ["Parent", "Spouse", "Sibling", "Child", "Friend", "Other"] as const;

const INDIAN_STATE_NAMES = [
  "Jammu and Kashmir", "Himachal Pradesh", "Punjab", "Chandigarh", "Uttarakhand", "Haryana",
  "Delhi", "Rajasthan", "Uttar Pradesh", "Bihar", "Sikkim", "Arunachal Pradesh", "Nagaland",
  "Manipur", "Mizoram", "Tripura", "Meghalaya", "Assam", "West Bengal", "Jharkhand", "Odisha",
  "Chhattisgarh", "Madhya Pradesh", "Gujarat", "Maharashtra", "Karnataka", "Kerala",
  "Tamil Nadu", "Telangana", "Andhra Pradesh",
] as const;

const INDIAN_CITIES_BY_STATE: Record<string, readonly string[]> = {
  Maharashtra: ["Mumbai", "Pune", "Nagpur", "Nashik", "Thane", "Aurangabad"],
  Karnataka: ["Bengaluru", "Mysuru", "Mangaluru", "Hubballi"],
  Delhi: ["New Delhi", "Delhi"],
  "Tamil Nadu": ["Chennai", "Coimbatore", "Madurai", "Tiruchirappalli"],
  Telangana: ["Hyderabad", "Warangal", "Nizamabad"],
  "Uttar Pradesh": ["Lucknow", "Noida", "Ghaziabad", "Kanpur", "Varanasi"],
  Gujarat: ["Ahmedabad", "Surat", "Vadodara", "Rajkot", "Gandhinagar"],
  "West Bengal": ["Kolkata", "Howrah", "Durgapur", "Siliguri"],
  Rajasthan: ["Jaipur", "Jodhpur", "Udaipur", "Kota"],
  Kerala: ["Thiruvananthapuram", "Kochi", "Kozhikode", "Thrissur"],
  "Madhya Pradesh": ["Bhopal", "Indore", "Gwalior", "Jabalpur"],
  Haryana: ["Gurugram", "Faridabad", "Panipat", "Ambala"],
  Punjab: ["Chandigarh", "Ludhiana", "Amritsar", "Jalandhar"],
  Bihar: ["Patna", "Gaya", "Muzaffarpur", "Bhagalpur"],
  Odisha: ["Bhubaneswar", "Cuttack", "Rourkela"],
  Assam: ["Guwahati", "Silchar", "Dibrugarh", "Jorhat"],
  Jharkhand: ["Ranchi", "Jamshedpur", "Dhanbad"],
  Chhattisgarh: ["Raipur", "Bhilai", "Bilaspur"],
  Uttarakhand: ["Dehradun", "Haridwar", "Rishikesh"],
  "Andhra Pradesh": ["Visakhapatnam", "Vijayawada", "Guntur", "Nellore", "Tirupati"],
  "Himachal Pradesh": ["Shimla", "Dharamshala", "Solan"],
  Chandigarh: ["Chandigarh"],
  Goa: ["Panaji", "Margao"],
  "Jammu and Kashmir": ["Srinagar", "Jammu"],
};

const dateOfBirthSchema = z
  .string()
  .refine((val) => !Number.isNaN(Date.parse(val)), "Invalid date of birth")
  .refine((val) => new Date(val).getTime() <= Date.now(), "Date of birth cannot be in the future")
  .refine((val) => {
    const ageYears = (Date.now() - new Date(val).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return ageYears >= 14 && ageYears <= 100;
  }, "Date of birth must correspond to an age between 14 and 100");

export const personalDetailsSchema = z
  .object({
    phone: z.string().regex(PHONE_REGEX, "Enter a valid phone number"),
    gender: z.enum(["MALE", "FEMALE", "OTHER"]).optional(),
    dateOfBirth: dateOfBirthSchema,
    emergencyName: z
      .string()
      .min(2, "Emergency contact name is required")
      .regex(PERSON_NAME_REGEX, "Enter a valid full name"),
    emergencyRelation: z.enum(EMERGENCY_RELATIONSHIPS, {
      errorMap: () => ({ message: "Select a valid relationship" }),
    }),
    emergencyPhone: z.string().regex(PHONE_REGEX, "Enter a valid phone number"),
    addressLine1: z
      .string()
      .optional()
      .refine((val) => !val || STREET_ADDRESS_REGEX.test(val.trim()), "Enter a valid street address"),
    addressCity: z.string().optional(),
    addressState: z
      .string()
      .optional()
      .refine((val) => !val || (INDIAN_STATE_NAMES as readonly string[]).includes(val), "Select a valid state"),
    addressPostalCode: z
      .string()
      .optional()
      .refine((val) => !val || INDIAN_PINCODE_REGEX.test(val.trim()), "Enter a valid 6-digit PIN code"),
    addressCountry: z.string().optional(),
  })
  .refine((val) => val.phone !== val.emergencyPhone, {
    message: "Emergency contact phone number must be different from your own phone number",
    path: ["emergencyPhone"],
  })
  .superRefine((val, ctx) => {
    const hasAddress =
      Boolean(val.addressLine1?.trim()) ||
      Boolean(val.addressCity?.trim()) ||
      Boolean(val.addressState?.trim()) ||
      Boolean(val.addressPostalCode?.trim()) ||
      Boolean(val.addressCountry?.trim());

    if (!hasAddress) return;

    if (!val.addressCountry?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a country", path: ["addressCountry"] });
      return;
    }
    if (val.addressCountry !== INDIA_COUNTRY_NAME) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Structured address is currently supported for India only",
        path: ["addressCountry"],
      });
      return;
    }
    if (!val.addressState?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a state", path: ["addressState"] });
    }
    if (!val.addressCity?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select a city", path: ["addressCity"] });
    } else if (
      val.addressState &&
      !(INDIAN_CITIES_BY_STATE[val.addressState] ?? []).includes(val.addressCity)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select a valid city for the chosen state",
        path: ["addressCity"],
      });
    }
    if (!val.addressPostalCode?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid PIN code", path: ["addressPostalCode"] });
    }
    if (!val.addressLine1?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Street address is required when adding a home address",
        path: ["addressLine1"],
      });
    }
  });

export const initiateSchema = z.object({
  userId: z.string().min(1),
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
