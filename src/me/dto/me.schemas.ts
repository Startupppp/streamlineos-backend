import { z } from "zod";

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).optional(),
  lastName: z.string().min(1).max(50).optional(),
  phone: z.string().max(15).optional(),
  whatsappNumber: z.string().max(15).optional(),
  emergencyContact: z
    .object({
      name: z.string().min(1),
      relation: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional(),
    })
    .optional(),
  bankDetails: z
    .object({
      accountNumber: z.string().min(1),
      bankName: z.string().min(1),
      branch: z.string().min(1),
      ifsc: z.string().min(1),
      accountHolder: z.string().min(1),
      pfUanNumber: z.string().optional(),
    })
    .optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
