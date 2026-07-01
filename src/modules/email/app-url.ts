function resolveAppUrl(): string {
  const configured =
    process.env.APP_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return "http://localhost:1000";
}

export const appUrl = resolveAppUrl();
