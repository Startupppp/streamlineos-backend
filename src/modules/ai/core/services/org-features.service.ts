import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";

export interface OrgFeatureFlags {
  aiChat: boolean;
  aiLeadScoring: boolean;
  aiEmailDraft: boolean;
  aiSmartNotifications: boolean;
  aiWeeklyRecap: boolean;
  supportAi: boolean;
}

const DEFAULT_FLAGS: OrgFeatureFlags = {
  aiChat: true,
  aiLeadScoring: true,
  aiEmailDraft: true,
  aiSmartNotifications: true,
  aiWeeklyRecap: true,
  supportAi: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readBooleanFlag(features: Record<string, unknown>, key: keyof OrgFeatureFlags, fallback: boolean): boolean {
  const value = features[key];
  return typeof value === "boolean" ? value : fallback;
}

function parseOrgFeatureFlags(settings: Record<string, unknown> | null | undefined): OrgFeatureFlags {
  const rawFeatures = settings?.features;
  const features = isRecord(rawFeatures) ? rawFeatures : {};
  return {
    aiChat: readBooleanFlag(features, "aiChat", DEFAULT_FLAGS.aiChat),
    aiLeadScoring: readBooleanFlag(features, "aiLeadScoring", DEFAULT_FLAGS.aiLeadScoring),
    aiEmailDraft: readBooleanFlag(features, "aiEmailDraft", DEFAULT_FLAGS.aiEmailDraft),
    aiSmartNotifications: readBooleanFlag(features, "aiSmartNotifications", DEFAULT_FLAGS.aiSmartNotifications),
    aiWeeklyRecap: readBooleanFlag(features, "aiWeeklyRecap", DEFAULT_FLAGS.aiWeeklyRecap),
    supportAi: readBooleanFlag(features, "supportAi", DEFAULT_FLAGS.supportAi),
  };
}

@Injectable()
export class OrgFeaturesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getFlags(orgId: string): Promise<OrgFeatureFlags> {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { settings: true },
    });
    return parseOrgFeatureFlags(org?.settings ?? null);
  }
}
