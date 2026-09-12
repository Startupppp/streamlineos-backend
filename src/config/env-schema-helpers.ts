import { z } from "zod";

export const deploymentSecret = z.string().min(32).optional();
export const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
export const optionalEmail = z.preprocess(
  emptyToUndefined,
  z.string().trim().email().optional(),
);
export const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().trim().url().optional(),
);

export const AWS_RDS_HOST = /\.rds\.amazonaws\.com$/i;
const DATABASE_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export function parseDatabaseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export const databaseUrl = (name: string) =>
  z.string().trim().superRefine((value, context) => {
    const parsed = parseDatabaseUrl(value);
    if (!parsed) {
      context.addIssue({ code: "custom", message: `${name} must be a valid PostgreSQL URL` });
      return;
    }
    if (!DATABASE_PROTOCOLS.has(parsed.protocol))
      context.addIssue({ code: "custom", message: `${name} must use postgres:// or postgresql://` });
    if (!parsed.username)
      context.addIssue({ code: "custom", message: `${name} must include a database username` });
    if (!parsed.hostname)
      context.addIssue({ code: "custom", message: `${name} must include a database hostname` });
    if (!parsed.pathname || parsed.pathname === "/")
      context.addIssue({ code: "custom", message: `${name} must include a database name` });

    if (AWS_RDS_HOST.test(parsed.hostname)) {
      const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
      if (!sslMode || !["require", "verify-ca", "verify-full"].includes(sslMode))
        context.addIssue({
          code: "custom",
          message: `${name} points at AWS RDS/Aurora and must set sslmode=require (or verify-ca/verify-full)`,
        });
    }
  });

export const optionalDatabaseUrl = (name: string) =>
  z.preprocess(emptyToUndefined, databaseUrl(name).optional());

export function endpointIdentity(url: URL): string {
  const host = url.hostname
    .replace(/-pooler(?=\.)/i, "")
    .replace(/\.cluster-ro-(?=[a-z0-9-]+\.)/i, ".cluster-")
    .toLowerCase();
  return `${host}:${url.port || "5432"}${url.pathname}`;
}

export function decodedUsername(url: URL): string {
  try {
    return decodeURIComponent(url.username);
  } catch {
    return url.username;
  }
}
