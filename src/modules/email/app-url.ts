function resolveAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  return "http://localhost:1000";
}

export const appUrl = resolveAppUrl();
