import {
  getVerificationEmailTemplate,
  getMagicLinkEmailTemplate,
  getWelcomeEmailTemplate,
  getAccountDeactivationEmailTemplate,
  getAccountLockedEmailTemplate,
  getEmailOtpTemplate,
} from "../index";
import { BASE_URL, BRAND } from "./_shared";
import type { TemplateEntry } from "./_shared";

export const authTemplates: Record<string, TemplateEntry> = {
  "auth.verify": {
    category: "Auth",
    name: "Email Verification",
    subject: "Verify your email address",
    generateHtml: () => getVerificationEmailTemplate(`${BASE_URL()}/verify-email?token=test-token`),
  },
  "auth.magic_link": {
    category: "Auth",
    name: "Magic Link Sign-In",
    subject: "Your sign-in link",
    generateHtml: () => getMagicLinkEmailTemplate(`${BASE_URL()}/magic-link?token=test-token`),
  },
  "auth.welcome": {
    category: "Auth",
    name: "Welcome / Account Created",
    subject: `Your ${BRAND} account is ready`,
    generateHtml: () =>
      getWelcomeEmailTemplate("Priya Sharma", "priya@acme.in", `${BASE_URL()}/setup?token=test-token`),
  },
  "auth.account_deactivated": {
    category: "Auth",
    name: "Account Deactivated",
    subject: "Your account has been deactivated",
    generateHtml: () => getAccountDeactivationEmailTemplate("Priya Sharma", "HR Admin", "Account closure requested"),
  },
  "auth.account_locked": {
    category: "Auth",
    name: "Account Locked",
    subject: "Your account is temporarily locked",
    generateHtml: () => getAccountLockedEmailTemplate("Priya Sharma"),
  },
  "auth.otp": {
    category: "Auth",
    name: "Sign-In OTP",
    subject: "Your sign-in code",
    generateHtml: () => getEmailOtpTemplate("482917"),
  },
};
