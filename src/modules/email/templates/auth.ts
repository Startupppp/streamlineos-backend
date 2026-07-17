import { getEmailTemplate, appUrl, escapeHtml } from "./base";
import { renderButton, renderCallout, renderFallbackLink, renderKeyValueRows } from "./components";

export function getVerificationEmailTemplate(verificationUrl: string): string {
  const content = `
    <h1 class="email-title">Verify your email address</h1>
    <p class="email-text">
      Confirm your email address to activate your StreamlineOS account.
    </p>
    ${renderButton("Verify email", verificationUrl)}
    ${renderCallout("This link expires in 24 hours. If you did not sign up for StreamlineOS, you can safely ignore this email.")}
    ${renderFallbackLink(verificationUrl)}
  `;

  return getEmailTemplate({
    title: "Verify your email address",
    preheader: "Confirm your email address to activate your StreamlineOS account.",
    content,
  });
}

export function getMagicLinkEmailTemplate(magicLinkUrl: string): string {
  const content = `
    <h1 class="email-title">Your sign-in link</h1>
    <p class="email-text">
      A one-click sign-in was requested for your StreamlineOS account.
    </p>
    ${renderButton("Sign in to StreamlineOS", magicLinkUrl)}
    ${renderCallout("This link expires in 1 hour and can only be used once. If you did not request this, you can safely ignore this email.")}
    ${renderFallbackLink(magicLinkUrl)}
  `;

  return getEmailTemplate({
    title: "Your sign-in link",
    preheader: "Your one-time sign-in link for StreamlineOS — expires in 1 hour.",
    content,
  });
}

export function getWelcomeEmailTemplate(name: string, email: string, setupUrl: string): string {
  const sName = escapeHtml(name);

  const content = `
    <h1 class="email-title">Your StreamlineOS account is ready</h1>
    <p class="email-text">
      Hi ${sName}, your StreamlineOS account has been created. Set up your account to get started.
    </p>
    ${renderKeyValueRows([{ label: "Login email", value: email }])}
    ${renderButton("Set up your account", setupUrl)}
    ${renderCallout("This setup link is valid for 7 days. If you were not expecting this email, contact your administrator.")}
  `;

  return getEmailTemplate({
    title: "Your StreamlineOS account is ready",
    preheader: "Your StreamlineOS account is ready — set up your account to get started.",
    content,
  });
}

export function getAccountDeactivationEmailTemplate(
  employeeName: string,
  deactivatedBy: string,
  reason?: string,
): string {
  const sEmployee = escapeHtml(employeeName);
  const rows: Array<{ label: string; value: string }> = [{ label: "Deactivated by", value: deactivatedBy }];
  if (reason) {
    rows.push({ label: "Reason", value: reason });
  }

  const content = `
    <h1 class="email-title">Your account has been deactivated</h1>
    <p class="email-text">
      Hi ${sEmployee}, your StreamlineOS account has been deactivated.
    </p>
    ${renderKeyValueRows(rows)}
    ${renderCallout("Contact your administrator to restore access.")}
  `;

  return getEmailTemplate({
    title: "Your account has been deactivated",
    preheader: "Your StreamlineOS account has been deactivated.",
    content,
  });
}

export function getEmailOtpTemplate(code: string): string {
  const digits = code.split("").join("&thinsp;");

  const content = `
    <h1 class="email-title">Your sign-in code</h1>
    <p class="email-text">
      Use the code below to sign in to your StreamlineOS account.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <span style="font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:700;letter-spacing:0.12em;color:#0b1220;background:#f8fafc;padding:14px 28px;border-radius:10px;border:1px solid #e2e8f0;display:inline-block;">${digits}</span>
    </div>
    ${renderCallout("This code expires in 10 minutes and can only be used once. If you did not request this, you can safely ignore this email.")}
  `;

  return getEmailTemplate({
    title: "Your sign-in code",
    preheader: "Your one-time sign-in code for StreamlineOS — expires in 10 minutes.",
    content,
  });
}

export function getAccountLockedEmailTemplate(name: string): string {
  const sName = escapeHtml(name);

  const content = `
    <h1 class="email-title">Your account is temporarily locked</h1>
    <p class="email-text">
      Hi ${sName}, your StreamlineOS account was locked after 5 failed sign-in attempts.
    </p>
    ${renderCallout("Your account will unlock automatically in 15 minutes. You can sign in again after the lockout period using a magic link or one-time code.", "warning")}
    ${renderButton("Sign in to StreamlineOS", `${appUrl}/signin`)}
  `;

  return getEmailTemplate({
    title: "Your account is temporarily locked",
    preheader: "Your StreamlineOS account has been temporarily locked.",
    content,
  });
}
