import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { organizations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";

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

function parseOrgFeatureFlags(settings: Record<string, unknown> | null | undefined): OrgFeatureFlags {
  const features = (settings?.features ?? {}) as Partial<OrgFeatureFlags>;
  return {
    aiChat: features.aiChat ?? DEFAULT_FLAGS.aiChat,
    aiLeadScoring: features.aiLeadScoring ?? DEFAULT_FLAGS.aiLeadScoring,
    aiEmailDraft: features.aiEmailDraft ?? DEFAULT_FLAGS.aiEmailDraft,
    aiSmartNotifications: features.aiSmartNotifications ?? DEFAULT_FLAGS.aiSmartNotifications,
    aiWeeklyRecap: features.aiWeeklyRecap ?? DEFAULT_FLAGS.aiWeeklyRecap,
    supportAi: features.supportAi ?? DEFAULT_FLAGS.supportAi,
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
