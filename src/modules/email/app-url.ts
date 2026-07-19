/**
 * Public site URL used in email links (verify, invites, etc.).
 * Prefer EMAIL_APP_URL when the API runs locally against a shared DB
 * so verification links still point at the real frontend.
 */
function resolveAppUrl(): string {
  const url = (process.env.EMAIL_APP_URL ?? process.env.APP_URL)?.trim();
  if (!url) {
    throw new Error(
      "[email] APP_URL is not set. Add APP_URL=https://your-domain.com to the backend environment variables.",
    );
  }
  const normalized = url.replace(/\/$/, "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized)) {
    console.warn(
      `[email] Link base is ${normalized}. Verification emails will open localhost — set EMAIL_APP_URL=https://www.streamlineos.in if recipients are not on this machine.`,
    );
  }
  return normalized;
}

export const appUrl = resolveAppUrl();
