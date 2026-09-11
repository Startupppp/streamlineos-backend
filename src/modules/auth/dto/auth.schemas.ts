import { z } from "zod";

export const registerSchema = z.object({
  firstName: z.string().min(1, "First name is required").max(100),
  lastName: z.string().max(100).optional().default(""),
  email: z.string().email("Valid email required").max(254),
  companyName: z.string().min(1, "Company name is required").max(200),
  phone: z.string().max(32).optional(),
  plan: z.string().max(50).optional(),
  /**
   * ISO 3166-1 alpha-2, and what decides which region the tenant is placed in.
   *
   * Optional, because omitting it must keep the previous behaviour exactly:
   * `regionForNewOrg()` with no argument returns the primary, as it did before
   * ticket 09. Without this field the placement work was inert -- the resolver
   * could place by country and nothing ever told it one.
   */
  country: z.string().length(2).toUpperCase().optional(),
}).strict();

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

export type RegisterInput = z.infer<typeof registerSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type MagicLinkRequestInput = z.infer<typeof magicLinkRequestSchema>;
export type MagicLinkVerifyInput = z.infer<typeof magicLinkVerifySchema>;

export const googleOAuthSchema = z.object({
  email: z.string().email().max(254),
  googleId: z.string().min(1).max(255),
  name: z.string().max(200).optional(),
  image: z.string().url().max(2048).optional().or(z.literal("")),
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
