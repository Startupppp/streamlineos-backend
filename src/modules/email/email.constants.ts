const BRAND_SUPPORT_EMAIL = "support@streamlineos.in";
/** Resend sandbox sender — only delivers to the Resend account owner. */
const RESEND_SANDBOX_FROM = "onboarding@resend.dev";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getFromEmail(): string {
  const fromEmail = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (
    fromEmail &&
    EMAIL_RE.test(fromEmail) &&
    fromEmail.toLowerCase() !== RESEND_SANDBOX_FROM
  ) {
    return fromEmail;
  }
  return BRAND_SUPPORT_EMAIL;
}

function getFromName(): string | undefined {
  return process.env.EMAIL_FROM_NAME?.trim() || undefined;
}

export function getFromAddress(): string {
  const name = getFromName();
  const email = getFromEmail();
  return name ? `${name} <${email}>` : email;
}

export function getFromParts(): { address: string; name: string } {
  return { address: getFromEmail(), name: getFromName() ?? "" };
}

export function getSupportEmail(): string {
  return getFromEmail();
}

export function getBrandUrl(): string {
  return (process.env.APP_URL?.trim() ?? "").replace(/\/$/, "");
}

export const EMAIL_LOGO_URL =
  "https://pub-891e5f8831c54f9295d7dda0eac7ed65.r2.dev/email-assets/logo-v2.png";
