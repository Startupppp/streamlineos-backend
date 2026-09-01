import { getBrandName } from "../branding";
import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import {
  renderButton,
  renderCallout,
  renderCredentialField,
  renderFallbackLink,
  renderKeyValueRows,
  renderOtpCode,
} from "./components";
import {
  EMAIL_TEMPLATE_VERSION,
  resolveLocaleText,
  resolveLocaleValue,
  type LocalizedValues,
} from "./email-locale";

export const AUTH_TEMPLATE_VERSION = EMAIL_TEMPLATE_VERSION;
export const AUTH_TEMPLATE_LOCALES = ["en", "fr", "es", "de"] as const;

const VERIFY_TITLE_MAP: LocalizedValues<string> = {
  en: "Verify your email address",
  fr: "Vérifiez votre adresse e-mail",
  es: "Verifica tu dirección de correo electrónico",
  de: "Bestätige deine E-Mail-Adresse",
};

const VERIFY_BODY_MAP: LocalizedValues<(brand: string) => string> = {
  en: (b) => `Confirm your email address to activate your ${b} account.`,
  fr: (b) => `Confirmez votre adresse e-mail pour activer votre compte ${b}.`,
  es: (b) => `Confirma tu dirección de correo electrónico para activar tu cuenta de ${b}.`,
  de: (b) => `Bestätige deine E-Mail-Adresse, um dein ${b}-Konto zu aktivieren.`,
};

const VERIFY_BUTTON_MAP: LocalizedValues<string> = {
  en: "Verify email",
  fr: "Vérifier l'e-mail",
  es: "Verificar correo electrónico",
  de: "E-Mail bestätigen",
};

const VERIFY_CALLOUT_MAP: LocalizedValues<(brand: string) => string> = {
  en: (b) => `This link expires in 24 hours. If you did not sign up for ${b}, you can safely ignore this email.`,
  fr: (b) => `Ce lien expire dans 24 heures. Si vous ne vous êtes pas inscrit à ${b}, vous pouvez ignorer cet e-mail.`,
  es: (b) => `Este enlace caduca en 24 horas. Si no te registraste en ${b}, puedes ignorar este correo electrónico.`,
  de: (b) => `Dieser Link läuft in 24 Stunden ab. Wenn du dich nicht bei ${b} angemeldet hast, kannst du diese E-Mail ignorieren.`,
};

const VERIFY_PREHEADER_MAP: LocalizedValues<(brand: string) => string> = {
  en: (b) => `Confirm your email address to activate your ${b} account.`,
  fr: (b) => `Confirmez votre adresse e-mail pour activer votre compte ${b}.`,
  es: (b) => `Confirma tu dirección de correo para activar tu cuenta de ${b}.`,
  de: (b) => `Bestätige deine E-Mail-Adresse, um dein ${b}-Konto zu aktivieren.`,
};

export function getVerificationEmailTemplate(verificationUrl: string, locale = "en"): string {
  const brand = getBrandName();
  const sBrand = escapeHtml(brand);
  const title = resolveLocaleText(locale, VERIFY_TITLE_MAP);
  const bodyFn = resolveLocaleValue(locale, VERIFY_BODY_MAP);
  const buttonLabel = resolveLocaleText(locale, VERIFY_BUTTON_MAP);
  const calloutFn = resolveLocaleValue(locale, VERIFY_CALLOUT_MAP);
  const preheaderFn = resolveLocaleValue(locale, VERIFY_PREHEADER_MAP);

  const content = `
    <h1 class="email-title">${escapeHtml(title)}</h1>
    <p class="email-text">
      ${escapeHtml(bodyFn(brand))}
    </p>
    ${renderButton(buttonLabel, verificationUrl)}
    ${renderCallout(calloutFn(sBrand))}
    ${renderFallbackLink(verificationUrl)}
  `;

  return getEmailTemplate({
    title,
    preheader: preheaderFn(brand),
    content,
  });
}

export function getVerificationEmailSubject(locale = "en"): string {
  return resolveLocaleText(locale, VERIFY_TITLE_MAP);
}

export function getMagicLinkEmailTemplate(magicLinkUrl: string): string {
  const brand = getBrandName();
  const content = `
    <h1 class="email-title">Your sign-in link</h1>
    <p class="email-text">
      Use the button below to sign in to ${escapeHtml(brand)}. This link works once and expires in 1 hour.
    </p>
    ${renderButton(`Sign in to ${brand}`, magicLinkUrl)}
    ${renderCallout("If you did not request this sign-in link, you can safely ignore this email.")}
    ${renderFallbackLink(magicLinkUrl)}
  `;

  return getEmailTemplate({
    title: "Your sign-in link",
    preheader: `Your one-time ${brand} sign-in link — expires in 1 hour.`,
    content,
  });
}

export function getWelcomeEmailTemplate(name: string, email: string, setupUrl: string): string {
  const brand = getBrandName();
  const sName = escapeHtml(name);
  const sBrand = escapeHtml(brand);

  const content = `
    <h1 class="email-title">Your ${sBrand} account is ready</h1>
    <p class="email-text">
      Hi ${sName}, your ${sBrand} account has been created. Set up your account to get started.
    </p>
    ${renderCredentialField("Login email", email)}
    ${renderButton("Set up your account", setupUrl)}
    ${renderCallout("This setup link is valid for 7 days. If you were not expecting this email, contact your administrator.")}
  `;

  return getEmailTemplate({
    title: `Your ${brand} account is ready`,
    preheader: `Your ${brand} account is ready — set up your account to get started.`,
    content,
  });
}

export function getAccountDeactivationEmailTemplate(
  employeeName: string,
  deactivatedBy: string,
  reason?: string,
): string {
  const brand = getBrandName();
  const sEmployee = escapeHtml(employeeName);
  const rows: Array<{ label: string; value: string }> = [{ label: "Deactivated by", value: deactivatedBy }];
  if (reason) {
    rows.push({ label: "Reason", value: reason });
  }

  const content = `
    <h1 class="email-title">Your account has been deactivated</h1>
    <p class="email-text">
      Hi ${sEmployee}, your ${escapeHtml(brand)} account has been deactivated.
    </p>
    ${renderKeyValueRows(rows)}
    ${renderCallout("Contact your administrator to restore access.")}
  `;

  return getEmailTemplate({
    title: "Your account has been deactivated",
    preheader: `Your ${brand} account has been deactivated.`,
    content,
  });
}

export function getEmailOtpTemplate(code: string): string {
  const brand = getBrandName();
  const safeCode = escapeHtml(code);
  const content = `
    <h1 class="email-title">Your sign-in code</h1>
    <p class="email-text">
      Enter this code to sign in to ${escapeHtml(brand)}. It expires in 10 minutes.
    </p>
    ${renderOtpCode(code)}
    ${renderCallout("This code can only be used once. If you did not request it, you can safely ignore this email.")}
  `;

  return getEmailTemplate({
    title: "Your sign-in code",
    preheader: `Your ${brand} sign-in code is ${safeCode} — expires in 10 minutes.`,
    content,
  });
}

export function getAccountLockedEmailTemplate(name: string): string {
  const brand = getBrandName();
  const sName = escapeHtml(name);

  const content = `
    <h1 class="email-title">Your account is temporarily locked</h1>
    <p class="email-text">
      Hi ${sName}, your ${escapeHtml(brand)} account was locked after 5 failed sign-in attempts.
    </p>
    ${renderCallout("Your account unlocks automatically in 15 minutes. You can also sign in again with a magic link or one-time code after the lockout ends.", "warning")}
    ${renderButton(`Sign in to ${brand}`, `${appUrl()}/signin`)}
  `;

  return getEmailTemplate({
    title: "Your account is temporarily locked",
    preheader: `Your ${brand} account has been temporarily locked.`,
    content,
  });
}
