import {
  getVerificationEmailTemplate,
  getVerificationEmailSubject,
  getMagicLinkEmailTemplate,
  getWelcomeEmailTemplate,
  getAccountDeactivationEmailTemplate,
  getAccountLockedEmailTemplate,
  getEmailOtpTemplate,
} from "../index";
import { BASE_URL, BRAND, EMAIL_TEMPLATE_VERSION, defineTemplateFamily } from "./_shared";
import { AUTH_TEMPLATE_LOCALES } from "../auth";

export const authTemplates = defineTemplateFamily({
  "auth.verify": {
    category: "Auth",
    name: "Email Verification",
    subject: (locale: string) => getVerificationEmailSubject(locale),
    generateHtml: (locale?: string) => getVerificationEmailTemplate(`${BASE_URL()}/verify-email?token=test-token`, locale),
    supportedLocales: AUTH_TEMPLATE_LOCALES,
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
}, EMAIL_TEMPLATE_VERSION);
