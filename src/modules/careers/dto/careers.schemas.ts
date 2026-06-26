import { z } from "zod";

export const applySchema = z.object({
  jobPostingId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  coverLetter: z.string().max(5000).optional(),
  resumeUrl: z.string().url().max(500).optional(),
});

export type ApplyInput = z.infer<typeof applySchema>;
