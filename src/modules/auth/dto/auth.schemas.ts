import { z } from "zod";

export const registerSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().optional().default(""),
  email: z.string().email("Valid email required"),
  companyName: z.string().min(1, "Company name is required"),
  phone: z.string().optional(),
  plan: z.string().optional(),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
}).strict();

export const resendVerificationSchema = z.object({
  email: z.string().email(),
}).strict();

export const magicLinkRequestSchema = z.object({
  email: z.string().email(),
}).strict();

export const magicLinkVerifySchema = z.object({
  token: z.string().min(1),
}).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestSchema>;
export type MagicLinkVerifyInput = z.infer<typeof magicLinkVerifySchema>;

export const googleOAuthSchema = z.object({
  email: z.string().email(),
  googleId: z.string().min(1),
  name: z.string().optional(),
  image: z.string().url().optional().or(z.literal("")),
}).strict();

export type GoogleOAuthInput = z.infer<typeof googleOAuthSchema>;

export const requestEmailOtpSchema = z.object({
  email: z.string().email(),
}).strict();

export const verifyEmailOtpSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
}).strict();

export type RequestEmailOtpInput = z.infer<typeof requestEmailOtpSchema>;
export type VerifyEmailOtpInput = z.infer<typeof verifyEmailOtpSchema>;
