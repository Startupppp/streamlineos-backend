import { getEmailTemplate, appUrl, escapeHtml } from "./base";

export function getVerificationEmailTemplate(verificationUrl: string): string {
  const content = `
    <h2 class="email-title">Verify Your Email Address</h2>
    <p class="email-text">
      Thank you for signing up! To complete your registration and access all features,
      please verify your email address by clicking the button below.
    </p>

    <div style="text-align: center;">
      <a href="${verificationUrl}" class="email-button">
        Verify Email Address
      </a>
    </div>

    <p class="email-text" style="font-size: 14px; color: #64748b; margin-top: 24px;">
      If the button doesn't work, you can copy and paste this link into your browser:
    </p>
    <p class="email-text" style="word-break: break-all; font-size: 13px; color: #0f2b7f;">
      ${verificationUrl}
    </p>

    <div class="security-notice">
      <p class="security-text">
        <strong>Security Notice:</strong> This link will expire in 24 hours.
        If you didn't create an account, please ignore this email.
      </p>
    </div>
  `;

  return getEmailTemplate({
    title: 'Verify Your Email - StreamlineOS',
    preheader: 'Complete your registration by verifying your email address',
    content,
  });
}

export function getPasswordResetEmailTemplate(resetUrl: string): string {
  const content = `
    <h2 class="email-title">Reset Your Password</h2>
    <p class="email-text">
      We received a request to reset your password. Click the button below to create a new password.
    </p>

    <div style="text-align: center;">
      <a href="${resetUrl}" class="email-button">
        Reset Password
      </a>
    </div>

    <p class="email-text" style="font-size: 14px; color: #64748b; margin-top: 24px;">
      If the button doesn't work, you can copy and paste this link into your browser:
    </p>
    <p class="email-text" style="word-break: break-all; font-size: 13px; color: #0f2b7f;">
      ${resetUrl}
    </p>

    <div class="divider"></div>

    <div class="security-notice">
      <p class="security-text">
        <strong>Security Notice:</strong> This link will expire in 1 hour.
        If you didn't request a password reset, please ignore this email or contact support if you have concerns.
      </p>
    </div>
  `;

  return getEmailTemplate({
    title: 'Reset Your Password - StreamlineOS',
    preheader: 'Click to reset your password securely',
    content,
  });
}

export function getWelcomeEmailTemplate(name: string, email: string, setupUrl: string): string {
  const sName = escapeHtml(name);
  const sEmail = escapeHtml(email);
  const content = `
    <h2 class="email-title">Welcome to StreamlineOS, ${sName}! 🚀</h2>
    <p class="email-text">
      Your account has been successfully created. We're excited to have you on board!
    </p>

    <p class="email-text">
      Click the button below to set up your password and activate your account:
    </p>

    <div style="text-align: center; margin: 24px 0;">
      <a href="${setupUrl}" class="email-button">
        Set Up Your Password
      </a>
    </div>

    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Your Email:</span>
        <span class="credential-value">${sEmail}</span>
      </div>
    </div>

    <div class="security-notice">
      <p class="security-text">
        This link expires in 7 days. If you didn't expect this email, please ignore it or contact your HR administrator.
      </p>
    </div>

    <div class="divider"></div>

    <p class="email-text">
      <strong>After setting up your password:</strong>
    </p>
    <ul style="color: #475569; font-size: 15px; line-height: 1.8; margin: 16px 0;">
      <li>Complete your profile with a photo and personal details</li>
      <li>Explore the dashboard to see your team and projects</li>
      <li>Set up your attendance tracking</li>
      <li>Check out your leave balances</li>
    </ul>
  `;

  return getEmailTemplate({
    title: 'Welcome to StreamlineOS — Set Up Your Account',
    preheader: 'Your account is ready — set up your password to get started!',
    content,
  });
}

export function getPasswordChangeConfirmationEmailTemplate(userName: string): string {
  const sUserName = escapeHtml(userName);
  const content = `
    <h2 class="email-title">🔒 Password Changed Successfully</h2>
    <p class="email-text">
      Hi <strong>${sUserName}</strong>,
    </p>

    <p class="email-text">
      Your password has been successfully changed. If you made this change, you can safely ignore this email.
    </p>

    <div class="security-notice">
      <p class="security-text">
        <strong>Security Alert:</strong> If you did NOT make this change, please contact our support team immediately
        at <a href="mailto:support@streamlineos.app" style="color: #92400e; text-decoration: underline;">support@streamlineos.app</a>
        or reset your password right away.
      </p>
    </div>

    <div class="divider"></div>

    <p class="email-text" style="font-size: 14px;">
      <strong>Security Tips:</strong>
    </p>
    <ul style="color: #475569; font-size: 14px; line-height: 1.8; margin: 16px 0;">
      <li>Use a strong, unique password for your account</li>
      <li>Never share your password with anyone</li>
      <li>Enable two-factor authentication if available</li>
      <li>Update your password regularly</li>
    </ul>
  `;

  return getEmailTemplate({
    title: 'Password Changed Successfully - StreamlineOS',
    preheader: 'Your password has been updated',
    content,
  });
}

export function getAccountDeactivationEmailTemplate(
  employeeName: string,
  deactivatedBy: string,
  reason?: string
): string {
  const sEmployee = escapeHtml(employeeName);
  const sDeactivatedBy = escapeHtml(deactivatedBy);
  const sReason = reason ? escapeHtml(reason) : undefined;
  const content = `
    <h2 class="email-title">👋 Account Deactivated</h2>
    <p class="email-text">
      Dear <strong>${sEmployee}</strong>,
    </p>

    <p class="email-text">
      Your account on StreamlineOS has been deactivated by <strong>${sDeactivatedBy}</strong>.
    </p>

    ${sReason ? `
    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Reason:</span>
        <span style="color: #475569; margin-left: 8px;">${sReason}</span>
      </div>
    </div>
    ` : ''}

    <p class="email-text">
      You will no longer have access to:
    </p>
    <ul style="color: #475569; font-size: 15px; line-height: 1.8; margin: 16px 0;">
      <li>The CRM dashboard and all projects</li>
      <li>Time tracking and attendance systems</li>
      <li>HR portal and leave management</li>
      <li>Company documents and files</li>
    </ul>

    <div class="divider"></div>

    <p class="email-text">
      If you believe this is an error or have questions, please contact HR at
      <a href="mailto:support@streamlineos.app" style="color: #0f2b7f; text-decoration: underline;">support@streamlineos.app</a>.
    </p>

    <p class="email-text" style="margin-top: 24px;">
      Thank you for your contributions to the organization.
    </p>
  `;

  return getEmailTemplate({
    title: 'Account Deactivated - StreamlineOS',
    preheader: 'Your account has been deactivated',
    content,
  });
}

export function getAccountLockedEmailTemplate(name: string): string {
  const sName = escapeHtml(name);
  const content = `
    <h2 class="email-title">Account Temporarily Locked</h2>
    <p class="email-text">
      Hi <strong>${sName}</strong>,
    </p>

    <p class="email-text">
      Your account has been temporarily locked due to multiple failed login attempts. This is a security measure to protect your account.
    </p>

    <div class="security-notice">
      <p class="security-text">
        <strong>Your account will be unlocked in 15 minutes.</strong>
        If you did not attempt to log in, your credentials may have been compromised.
        Please reset your password immediately.
      </p>
    </div>

    <div style="text-align: center;">
      <a href="${appUrl}/forgot-password" class="email-button">
        Reset Password
      </a>
    </div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      If you need immediate assistance, please contact our support team at
      <a href="mailto:support@streamlineos.app" style="color: #0f2b7f;">support@streamlineos.app</a>.
    </p>
  `;

  return getEmailTemplate({
    title: 'Account Locked - StreamlineOS',
    preheader: 'Your account has been temporarily locked',
    content,
  });
}

export function getNewDeviceLoginEmailTemplate(
  name: string,
  deviceInfo: { userAgent: string; ipAddress: string; time: string }
): string {
  const sName = escapeHtml(name);
  const sUserAgent = escapeHtml(deviceInfo.userAgent || "Unknown device");
  const sIp = escapeHtml(deviceInfo.ipAddress || "Unknown IP");
  const sTime = escapeHtml(deviceInfo.time);
  const content = `
    <h2 class="email-title">New Device Sign-In Detected</h2>
    <p class="email-text">
      Hi <strong>${sName}</strong>,
    </p>

    <p class="email-text">
      We detected a sign-in to your StreamlineOS account from a new device or location.
    </p>

    <div class="credential-box">
      <div class="credential-item">
        <span class="credential-label">Device:</span>
        <span style="color: #475569; margin-left: 8px; font-size: 13px;">${sUserAgent}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">IP Address:</span>
        <span style="color: #475569; margin-left: 8px; font-size: 13px;">${sIp}</span>
      </div>
      <div class="credential-item">
        <span class="credential-label">Time:</span>
        <span style="color: #475569; margin-left: 8px; font-size: 13px;">${sTime}</span>
      </div>
    </div>

    <div class="security-notice">
      <p class="security-text">
        <strong>Was this you?</strong> If you signed in, you can ignore this email.
        If you did NOT sign in, your account may be compromised. Reset your password immediately.
      </p>
    </div>

    <div style="text-align: center;">
      <a href="${appUrl}/forgot-password" class="email-button">
        Secure My Account
      </a>
    </div>
  `;

  return getEmailTemplate({
    title: 'New Device Sign-In - StreamlineOS',
    preheader: 'A new device signed into your account',
    content,
  });
}

export function getPasswordExpiryWarningEmailTemplate(name: string, daysLeft: number): string {
  const sName = escapeHtml(name);
  const content = `
    <h2 class="email-title">Your Password is Expiring Soon</h2>
    <p class="email-text">
      Hi <strong>${sName}</strong>,
    </p>

    <p class="email-text">
      Your StreamlineOS account password will expire in <strong>${daysLeft} day${daysLeft !== 1 ? "s" : ""}</strong>.
      Please update it before it expires to avoid being locked out of your account.
    </p>

    <div class="security-notice">
      <p class="security-text">
        <strong>Action Required:</strong> Update your password within the next ${daysLeft} day${daysLeft !== 1 ? "s" : ""}.
        After expiry you will be required to reset your password before you can log in.
      </p>
    </div>

    <div style="text-align: center;">
      <a href="${appUrl}/settings?tab=security" class="email-button">
        Update Password
      </a>
    </div>

    <p class="email-text" style="font-size: 14px; color: #64748b;">
      Choose a strong password with at least 8 characters, including uppercase, lowercase, numbers, and special characters.
    </p>
  `;

  return getEmailTemplate({
    title: 'Password Expiring Soon - StreamlineOS',
    preheader: `Your password expires in ${daysLeft} days`,
    content,
  });
}
