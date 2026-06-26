const BRAND_SUPPORT_EMAIL = "support@streamlineos.in";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getFromEmail(): string {
  const fromEmail = process.env.EMAIL_FROM_ADDRESS?.trim();
  return fromEmail && EMAIL_RE.test(fromEmail) ? fromEmail : BRAND_SUPPORT_EMAIL;
}

function getFromName(): string | undefined {
  return process.env.EMAIL_FROM_NAME?.trim() || undefined;
}

export function getFromAddress(): string {
  const name = getFromName();
  const email = getFromEmail();
  return name ? `${name} <${email}>` : email;
}
