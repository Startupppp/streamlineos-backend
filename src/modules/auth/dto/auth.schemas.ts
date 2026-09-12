import { z } from "zod";

export const verifyEmailSchema = z.object({
  token: z.string().min(1).max(256),
}).strict();

export const resendVerificationSchema = z.object({
  email: z.string().email().max(254),
}).strict();

export const magicLinkRequestSchema = z.object({
  email: z.string().email().max(254),
}).strict();

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1).max(256),
}).strict();

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestSchema>;
export type MagicLinkVerifyInput = z.infer<typeof magicLinkVerifySchema>;

export const googleOAuthSchema = z.object({
  email: z.string().email().max(254),
  googleId: z.string().min(1).max(255),
  name: z.string().max(200).optional(),
  // `.url()` alone admits `javascript:alert(1)` — that is a well-formed URL, and
  // this value is persisted to `users.image` and rendered as an avatar source.
  // The only thing an identity provider ever sends here is http(s).
  image: z
    .string()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "image must be an http or https URL",
    })
    .optional()
    .or(z.literal("")),
}).strict();

export type GoogleOAuthInput = z.infer<typeof googleOAuthSchema>;

export const requestEmailOtpSchema = z.object({
  email: z.string().email().max(254),
}).strict();

export const verifyEmailOtpSchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/),
}).strict();

export type RequestEmailOtpInput = z.infer<typeof requestEmailOtpSchema>;
export type VerifyEmailOtpInput = z.infer<typeof verifyEmailOtpSchema>;

export const sessionExchangeSchema = z
  .object({
    orgId: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();

export type SessionExchangeInput = z.infer<typeof sessionExchangeSchema>;
