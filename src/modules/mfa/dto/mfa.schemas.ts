import { z } from "zod";

export const verifyMfaSchema = z.union([
  z.object({ token: z.string().length(6) }).strict(),
  z.object({ backupCode: z.string().min(1) }).strict(),
]);

export const disableMfaSchema = z
  .object({
    token: z.string().length(6),
  })
  .strict();

export const resetMfaSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

export type VerifyMfaInput = z.infer<typeof verifyMfaSchema>;
export type DisableMfaInput = z.infer<typeof disableMfaSchema>;
export type ResetMfaInput = z.infer<typeof resetMfaSchema>;
