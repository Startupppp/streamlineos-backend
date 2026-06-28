import { createHash, randomBytes } from "crypto";

export const VALID_API_KEY_SCOPES = [
  "leads:read",
  "leads:write",
  "deals:read",
  "deals:write",
  "contacts:read",
  "contacts:write",
  "hr:read",
  "hr:write",
  "*",
] as const;

export interface OrgFeatureFlags {
  aiChat: boolean;
  aiLeadScoring: boolean;
  aiEmailDraft: boolean;
  aiSmartNotifications: boolean;
  aiWeeklyRecap: boolean;
}

const DEFAULT_FEATURE_FLAGS: OrgFeatureFlags = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
};

function resolveAppUrl(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

const APP_URL = resolveAppUrl();

export function generateWebhookSecret(): string {
  return randomBytes(30).toString("base64url").slice(0, 40);
}

export function generateApiKey(): { id: string; rawKey: string; keyHash: string; keyPrefix: string } {
  const rawKey = `streamlineos_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  return {
    id: randomBytes(16).toString("hex"),
    rawKey,
    keyHash,
    keyPrefix: rawKey.slice(0, 16),
  };
}

export function maskSecret(secret: string): string {
  if (secret.length <= 4) return "••••";
  return `${secret.slice(0, 4)}${"•".repeat(8)}`;
}

export function gitWebhookUrl(connectionId: number): string {
  return `${APP_URL}/api/integrations/git/webhook?connectionId=${connectionId}`;
}

export function parseOrgFeatureFlags(
  settings: Record<string, unknown> | null | undefined,
): OrgFeatureFlags {
  const features = (settings?.features ?? {}) as Partial<OrgFeatureFlags>;
  return {
    aiChat: features.aiChat ?? DEFAULT_FEATURE_FLAGS.aiChat,
    aiLeadScoring: features.aiLeadScoring ?? DEFAULT_FEATURE_FLAGS.aiLeadScoring,
    aiEmailDraft: features.aiEmailDraft ?? DEFAULT_FEATURE_FLAGS.aiEmailDraft,
    aiSmartNotifications: features.aiSmartNotifications ?? DEFAULT_FEATURE_FLAGS.aiSmartNotifications,
    aiWeeklyRecap: features.aiWeeklyRecap ?? DEFAULT_FEATURE_FLAGS.aiWeeklyRecap,
  };
}
