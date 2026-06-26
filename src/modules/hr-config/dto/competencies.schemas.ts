import { z } from "zod";

export const skillListQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createSkillSchema = z.object({
  userId: z.string().min(1).optional(),
  skillName: z
    .string()
    .trim()
    .min(2, "Skill name must be at least 2 characters")
    .max(50, "Skill name must be at most 50 characters"),
  level: z.number().int().min(1).max(5).optional().default(1),
});

export const certificationListQuerySchema = z.object({
  userId: z.string().min(1).optional(),
  expiringSoon: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createCertificationSchema = z
  .object({
    userId: z.string().min(1).optional(),
    name: z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters"),
    issuingOrganization: z.string().trim().min(1, "Issuing organization is required").max(200),
    issueDate: z.string().optional(),
    expiryDate: z.string().optional(),
    credentialId: z.string().min(1, "Credential ID is required").max(100),
    credentialUrl: z.string().url("Enter a valid URL").optional().or(z.literal("")),
    documentUrl: z.string().url("Enter a valid URL").optional().or(z.literal("")),
  })
  .refine((d) => !d.issueDate || !d.expiryDate || d.expiryDate >= d.issueDate, {
    message: "Expiry date must be after the issue date",
    path: ["expiryDate"],
  });

export type SkillListQuery = z.infer<typeof skillListQuerySchema>;
export type CreateSkillInput = z.infer<typeof createSkillSchema>;
export type CertificationListQuery = z.infer<typeof certificationListQuerySchema>;
export type CreateCertificationInput = z.infer<typeof createCertificationSchema>;
