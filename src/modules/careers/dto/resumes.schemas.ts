import { z } from "zod";

export const uploadResumeSchema = z.object({
  candidateId: z.number().int().positive(),
  fileName: z.string().min(1),
  fileType: z.string().min(1),
  // Resume upload requires an authenticated session or a valid tracking token
}).strict();

export type UploadResumeInput = z.infer<typeof uploadResumeSchema>;
