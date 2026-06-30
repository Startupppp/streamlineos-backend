import { z } from "zod";

const passwordSchema = z
  .string()
  .min(12, "Minimum 12 characters")
  .regex(/[A-Z]/, "Must include an uppercase letter")
  .regex(/[a-z]/, "Must include a lowercase letter")
  .regex(/[0-9]/, "Must include a number")
  .regex(/[^A-Za-z0-9]/, "Must include a special character");

export const registerSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().optional().default(""),
  email: z.string().email("Valid email required"),
  password: passwordSchema,
  companyName: z.string().min(1, "Company name is required"),
  phone: z.string().optional(),
  plan: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional().default(false),
  fingerprint: z.string().optional(),
  totpCode: z.string().length(6).optional(),
}).strict();

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
}).strict();

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
}).strict();

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
}).strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
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
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
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
