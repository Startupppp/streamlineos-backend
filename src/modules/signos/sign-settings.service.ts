import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { signOrgSettings } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import type { UpdateSignSettingsInput } from "./dto/signos.schemas";

export type SignOrgSettings = typeof signOrgSettings.$inferSelect;

const DEFAULTS: Omit<SignOrgSettings, "id" | "orgId" | "createdAt" | "updatedAt"> = {
  defaultExpirationDays: 30,
  expirationWarningDays: 3,
  defaultReminderFirstAfterDays: 3,
  defaultReminderRepeatDays: 3,
  defaultReminderMaxCount: 5,
  allowedFileTypes: ["application/pdf"],
  maxFileSizeMb: 25,
  allowedAuthMethods: ["email_link", "access_code", "otp_email"],
  certificateFormat: "pdf",
  retentionPolicyJson: {},
  publicFormsEnabled: true,
  bulkSendMaxRowsPerJob: 500,
  bulkSendMaxActiveJobs: 5,
  bulkSendMaxRecipientsPerEnvelope: 20,
  senderRateLimitPerHour: 200,
  brandingJson: {},
  webhookUrl: null,
  webhookSecret: null,
};

@Injectable()
export class SignSettingsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
  ) {}

  async getOrCreate(orgId: string): Promise<SignOrgSettings> {
    const existing = await this.db.query.signOrgSettings.findFirst({ where: eq(signOrgSettings.orgId, orgId) });
    if (existing) return existing;

    const [created] = await this.db
      .insert(signOrgSettings)
      .values({ orgId, ...DEFAULTS })
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    // Lost a race with a concurrent first-write; the row now exists.
    const row = await this.db.query.signOrgSettings.findFirst({ where: eq(signOrgSettings.orgId, orgId) });
    if (!row) throw new Error("Failed to load SignOS org settings");
    return row;
  }

  async update(orgId: string, input: UpdateSignSettingsInput, userId?: string): Promise<SignOrgSettings> {
    const current = await this.getOrCreate(orgId);
    const brandingJson = input.brandingJson
      ? { ...(current.brandingJson ?? {}), ...input.brandingJson }
      : current.brandingJson;

    const [updated] = await this.db
      .update(signOrgSettings)
      .set({
        ...input,
        brandingJson,
        updatedAt: new Date(),
      })
      .where(eq(signOrgSettings.orgId, orgId))
      .returning();

    await this.audit.record({
      orgId,
      actorType: userId ? "internal_user" : "system",
      actorUserId: userId,
      eventType: "admin_setting_changed",
      eventMessage: "Updated SignOS organization settings",
      eventPayload: input as Record<string, unknown>,
    });
    return updated;
  }
}
