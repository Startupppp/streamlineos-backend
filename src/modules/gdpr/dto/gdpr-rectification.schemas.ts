import { z } from "zod";

const addressValueSchema = z
  .object({
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(100).optional(),
    country: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(20).optional(),
  })
  .strict();

const emergencyContactValueSchema = z
  .object({
    name: z.string().trim().max(200).optional(),
    relationship: z.string().trim().max(100).optional(),
    phone: z.string().trim().max(30).optional(),
    email: z.string().trim().email().max(254).optional(),
  })
  .strict();

export const gdprRectificationBodySchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("profile.name"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ field: z.literal("hr_profile.personal_email"), value: z.string().trim().email().max(254) }).strict(),
  z.object({ field: z.literal("hr_profile.phone"), value: z.string().trim().min(1).max(30) }).strict(),
  z
    .object({
      field: z.literal("hr_profile.date_of_birth"),
      value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    })
    .strict(),
  z.object({ field: z.literal("hr_profile.gender"), value: z.string().trim().min(1).max(100) }).strict(),
  z.object({ field: z.literal("hr_profile.preferred_name"), value: z.string().trim().min(1).max(200) }).strict(),
  z.object({ field: z.literal("hr_profile.address"), value: addressValueSchema }).strict(),
  z.object({ field: z.literal("hr_profile.emergency_contact"), value: emergencyContactValueSchema }).strict(),
  z.object({ field: z.literal("hr_sensitive.bank_details"), value: z.string().trim().min(1).max(2000) }).strict(),
]);

export type GdprRectificationBody = z.infer<typeof gdprRectificationBodySchema>;
