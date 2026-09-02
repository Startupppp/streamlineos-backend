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
  supportAi: boolean;
}

const DEFAULT_FEATURE_FLAGS: OrgFeatureFlags = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
  supportAi: true,
};

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
    supportAi: features.supportAi ?? DEFAULT_FEATURE_FLAGS.supportAi,
  };
}
