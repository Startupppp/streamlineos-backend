import { getEmailTemplate, appUrl, escapeHtml } from "./base";

export function getVerificationEmailTemplate(verificationUrl: string): string {
  const content = `
    <h1 class="email-title">One step to activate your account</h1>
    <p class="email-text">
      Thanks for signing up. Click below to verify your email address and unlock your StreamlineOS workspace — it takes under 10 seconds.
    </p>

    <a href="${verificationUrl}" class="email-button">Verify my email &rarr;</a>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; Didn't create a StreamlineOS account? You can safely ignore this email — someone may have entered your address by mistake.
      </p>
    </div>

    <p class="email-label" style="margin-top:28px;">Or copy this link into your browser</p>
    <span class="fallback-url">${verificationUrl}</span>
  `;

  return getEmailTemplate({
    title: "Verify your email — StreamlineOS",
    preheader: "One click to activate your StreamlineOS account.",
    content,
  });
}

export function getMagicLinkEmailTemplate(magicLinkUrl: string): string {
  const content = `
    <h1 class="email-title">Sign in to StreamlineOS</h1>
    <p class="email-text">
      Click the button below to sign in securely — no password needed. This magic link is valid for <strong style="color:#334155;">1 hour</strong> and works only once.
    </p>

    <a href="${magicLinkUrl}" class="email-button">Sign in to StreamlineOS &rarr;</a>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; Didn't request this link? You can safely ignore this email — your account stays secure and no one can sign in without access to your inbox.
      </p>
    </div>

    <p class="email-label" style="margin-top:28px;">Or copy this link into your browser</p>
    <span class="fallback-url">${magicLinkUrl}</span>
  `;

  return getEmailTemplate({
    title: "Sign in to StreamlineOS",
    preheader: "Your one-time sign-in link — expires in 1 hour.",
    content,
  });
}

export function getPasswordResetEmailTemplate(resetUrl: string): string {
  const content = `
    <h1 class="email-title">Reset your password</h1>
    <p class="email-text">
      We received a request to reset the password on your StreamlineOS account. Click the button below to choose a new one.
    </p>

    <a href="${resetUrl}" class="email-button">Set a new password &rarr;</a>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; This link expires in <strong style="color:#334155;">1 hour</strong>. If you didn't request a password reset, no action is needed — your current password remains unchanged.
      </p>
    </div>

    <p class="email-label" style="margin-top:28px;">Or copy this link into your browser</p>
    <span class="fallback-url">${resetUrl}</span>
  `;

  return getEmailTemplate({
    title: "Reset your password — StreamlineOS",
    preheader: "Someone requested a password reset for your account.",
    content,
  });
}

export function getWelcomeEmailTemplate(name: string, email: string, setupUrl: string): string {
  const sName = escapeHtml(name);
  const sEmail = escapeHtml(email);

  const content = `
    <h1 class="email-title">Welcome, ${sName}</h1>
    <p class="email-text">
      Your StreamlineOS account is ready. Set up your password below to get into your workspace — from there you can complete your profile, check leave balances, and explore your team.
    </p>

    <a href="${setupUrl}" class="email-button">Set up your password &rarr;</a>

    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Your login email:</span>
        <span class="credential-value">${sEmail}</span>
      </div>
    </div>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; This setup link expires in <strong style="color:#334155;">7 days</strong>. If you weren't expecting this, contact your HR administrator.
      </p>
    </div>
  `;

  return getEmailTemplate({
    title: "Set up your StreamlineOS account",
    preheader: `Your account is ready, ${sName} — set up your password to get started.`,
    content,
  });
}

export function getPasswordChangeConfirmationEmailTemplate(userName: string): string {
  const sName = escapeHtml(userName);

  const content = `
    <h1 class="email-title">Your password was changed</h1>
    <p class="email-text">
      Hi ${sName}, this is a confirmation that your StreamlineOS password was successfully updated.
    </p>
    <p class="email-text">
      If you made this change, you're all set — no further action needed.
    </p>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; <strong style="color:#334155;">Wasn't you?</strong> Contact us immediately at <a href="mailto:support@streamlineos.app" style="color:#1e40af;text-decoration:underline;">support@streamlineos.app</a> or reset your password right away.
      </p>
    </div>

    <a href="${appUrl}/forgot-password" class="email-button" style="background:linear-gradient(135deg,#334155 0%,#475569 100%);border-color:#334155;">Secure my account &rarr;</a>
  `;

  return getEmailTemplate({
    title: "Password changed — StreamlineOS",
    preheader: "Your StreamlineOS password was successfully updated.",
    content,
  });
}

export function getAccountDeactivationEmailTemplate(
  employeeName: string,
  deactivatedBy: string,
  reason?: string,
): string {
  const sEmployee = escapeHtml(employeeName);
  const sDeactivatedBy = escapeHtml(deactivatedBy);
  const sReason = reason ? escapeHtml(reason) : undefined;

  const content = `
    <h1 class="email-title">Your account has been deactivated</h1>
    <p class="email-text">
      Hi ${sEmployee}, your StreamlineOS account was deactivated by <strong style="color:#334155;">${sDeactivatedBy}</strong>.
    </p>

    ${
      sReason
        ? `
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Reason:</span>
        <span style="color:#4A5568;margin-left:8px;">${sReason}</span>
      </div>
    </div>`
        : ""
    }

    <p class="email-text">
      You will no longer have access to the CRM dashboard, time tracking, HR portal, leave management, or company documents.
    </p>

    <hr class="divider">

    <p class="email-text" style="font-size:14px;">
      If you believe this is a mistake, please reach out to your HR administrator or contact us at <a href="mailto:support@streamlineos.app" style="color:#1e40af;text-decoration:underline;">support@streamlineos.app</a>.
    </p>
  `;

  return getEmailTemplate({
    title: "Account deactivated — StreamlineOS",
    preheader: "Your StreamlineOS account has been deactivated.",
    content,
  });
}

export function getAccountLockedEmailTemplate(name: string): string {
  const sName = escapeHtml(name);

  const content = `
    <h1 class="email-title">Account temporarily locked</h1>
    <p class="email-text">
      Hi ${sName}, your StreamlineOS account was locked after multiple failed login attempts. This is an automatic security measure.
    </p>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; Your account will unlock automatically in <strong style="color:#334155;">15 minutes</strong>. If you didn't make these attempts, your credentials may be compromised — reset your password now.
      </p>
    </div>

    <a href="${appUrl}/forgot-password" class="email-button">Reset my password &rarr;</a>

    <p class="email-text" style="font-size:14px;color:#94A3B8;">
      Need immediate help? Email <a href="mailto:support@streamlineos.app" style="color:#1e40af;text-decoration:underline;">support@streamlineos.app</a>.
    </p>
  `;

  return getEmailTemplate({
    title: "Account locked — StreamlineOS",
    preheader: "Your account was temporarily locked due to failed login attempts.",
    content,
  });
}

export function getNewDeviceLoginEmailTemplate(
  name: string,
  deviceInfo: { userAgent: string; ipAddress: string; time: string },
): string {
  const sName = escapeHtml(name);
  const sUserAgent = escapeHtml(deviceInfo.userAgent || "Unknown device");
  const sIp = escapeHtml(deviceInfo.ipAddress || "Unknown IP");
  const sTime = escapeHtml(deviceInfo.time);

  const content = `
    <h1 class="email-title">New sign-in detected</h1>
    <p class="email-text">
      Hi ${sName}, we noticed a sign-in to your StreamlineOS account from a device or location we haven't seen before.
    </p>

    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Device:</span>
        <span style="color:#4A5568;margin-left:8px;font-size:13px;">${sUserAgent}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">IP address:</span>
        <span style="color:#4A5568;margin-left:8px;font-size:13px;">${sIp}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Time:</span>
        <span style="color:#4A5568;margin-left:8px;font-size:13px;">${sTime}</span>
      </div>
    </div>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; <strong style="color:#334155;">Was this you?</strong> If so, no action needed. If not, secure your account immediately — someone else may have your password.
      </p>
    </div>

    <a href="${appUrl}/forgot-password" class="email-button" style="background:linear-gradient(135deg,#334155 0%,#475569 100%);border-color:#334155;">Secure my account &rarr;</a>
  `;

  return getEmailTemplate({
    title: "New device sign-in — StreamlineOS",
    preheader: "A new device signed into your StreamlineOS account.",
    content,
  });
}

export function getPasswordExpiryWarningEmailTemplate(name: string, daysLeft: number): string {
  const sName = escapeHtml(name);
  const dayWord = daysLeft === 1 ? "day" : "days";

  const content = `
    <h1 class="email-title">Your password expires in ${daysLeft} ${dayWord}</h1>
    <p class="email-text">
      Hi ${sName}, your StreamlineOS password will expire in <strong style="color:#334155;">${daysLeft} ${dayWord}</strong>. Update it now to avoid being locked out.
    </p>

    <a href="${appUrl}/settings?tab=security" class="email-button">Update my password &rarr;</a>

    <div class="security-notice">
      <p class="security-text">
        <span style="color:#06b6d4;">&#10022;</span>&nbsp; After expiry you'll need to reset your password before logging in. Your new password must be at least <strong style="color:#334155;">12 characters</strong> with upper, lower, number, and special character.
      </p>
    </div>
  `;

  return getEmailTemplate({
    title: `Password expires in ${daysLeft} ${dayWord} — StreamlineOS`,
    preheader: `Update your StreamlineOS password — it expires in ${daysLeft} ${dayWord}.`,
    content,
  });
}
