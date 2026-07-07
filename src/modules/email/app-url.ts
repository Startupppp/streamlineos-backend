function resolveAppUrl(): string {
  const url = process.env.APP_URL?.trim();
  if (!url) {
    throw new Error(
      "[email] APP_URL is not set. Add APP_URL=https://your-domain.com to the backend environment variables.",
    );
  }
  return url.replace(/\/$/, "");
}

export const appUrl = resolveAppUrl();
