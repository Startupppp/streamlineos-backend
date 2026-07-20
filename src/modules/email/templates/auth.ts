import { getBrandName } from "../branding";
import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import {
  renderButton,
  renderCallout,
  renderFallbackLink,
  renderKeyValueRows,
  renderOtpCode,
} from "./components";

export function getVerificationEmailTemplate(verificationUrl: string): string {
  const brand = getBrandName();
  const content = `
    <h1 class="email-title">Verify your email address</h1>
    <p class="email-text">
      Confirm your email address to activate your ${escapeHtml(brand)} account.
    </p>
    ${renderButton("Verify email", verificationUrl)}
    ${renderCallout(`This link expires in 24 hours. If you did not sign up for ${escapeHtml(brand)}, you can safely ignore this email.`)}
    ${renderFallbackLink(verificationUrl)}
  `;

  return getEmailTemplate({
    title: "Verify your email address",
    preheader: `Confirm your email address to activate your ${brand} account.`,
    content,
  });
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
    ${renderKeyValueRows([{ label: "Login email", value: email }])}
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
    ${renderButton(`Sign in to ${brand}`, `${appUrl}/signin`)}
  `;

  return getEmailTemplate({
    title: "Your account is temporarily locked",
    preheader: `Your ${brand} account has been temporarily locked.`,
    content,
  });
}
