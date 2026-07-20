const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getFromEmail(): string {
  const fromEmail = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!fromEmail || !EMAIL_RE.test(fromEmail)) {
    throw new Error("EMAIL_FROM_ADDRESS is missing or invalid in the backend environment");
  }
  return fromEmail;
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
  return ((process.env.EMAIL_APP_URL ?? process.env.APP_URL)?.trim() ?? "").replace(/\/$/, "");
}

export const EMAIL_LOGO_URL = `${(process.env.NEXT_PUBLIC_R2_PUBLIC_URL ?? "").trim().replace(/\/$/, "")}/email-assets/logo-v2.png`;
