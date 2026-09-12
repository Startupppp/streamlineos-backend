import { Inject, Injectable } from "@nestjs/common";
import { eq, getTableColumns } from "drizzle-orm";
import { signOrgSettings } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import type { UpdateSignSettingsInput } from "./dto/e-sign.schemas";

export type SignOrgSettings = typeof signOrgSettings.$inferSelect;

/**
 * PRD-C088 — `sign_org_settings.webhook_secret` is a plaintext shared secret
 * (`db/schema/e-sign/settings.ts:45`), and every read of this row used to carry it:
 * `getOrCreate` was a bare `findFirst` with no `columns`, `update` a bare
 * `.returning()`, and `GET /sign/admin/settings` returned whichever one ran verbatim.
 *
 * No consumer has ever read it — `grep -rn 'webhookSecret' src/modules/e-sign` finds
 * only the column, the default and this projection, and the browser client's
 * `SignOrgSettings` (`frontend/types/sign.ts:207`) does not declare it. So it is not
 * masked to a hint, it is not selected at all: the value never enters this process,
 * which is a stronger guarantee than stripping it on the way out and cannot be undone
 * by a later `.returning()` someone forgets to project.
 *
 * Anything that genuinely needs the secret to sign an outgoing webhook must read it
 * through its own narrow method, the way `webhooks.service.ts` does.
 */
const { webhookSecret: _withheldSecret, ...signOrgSettingsPublicColumns } =
  getTableColumns(signOrgSettings);

export type SignOrgSettingsPublic = Omit<SignOrgSettings, "webhookSecret">;

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

  async getOrCreate(orgId: string): Promise<SignOrgSettingsPublic> {
    const existing = await this.db.query.signOrgSettings.findFirst({
      columns: { webhookSecret: false },
      where: eq(signOrgSettings.orgId, orgId),
    });
    if (existing) return existing;

    const [created] = await this.db
      .insert(signOrgSettings)
      .values({ orgId, ...DEFAULTS })
      .onConflictDoNothing()
      .returning(signOrgSettingsPublicColumns);
    if (created) return created;

    // Lost a race with a concurrent first-write; the row now exists.
    const row = await this.db.query.signOrgSettings.findFirst({
      columns: { webhookSecret: false },
      where: eq(signOrgSettings.orgId, orgId),
    });
    if (!row) throw new Error("Failed to load SignOS org settings");
    return row;
  }

  async update(
    orgId: string,
    input: UpdateSignSettingsInput,
    userId?: string,
  ): Promise<SignOrgSettingsPublic> {
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
      .returning(signOrgSettingsPublicColumns);

    await this.audit.record({
      orgId,
      actorType: userId ? "internal_user" : "system",
      actorUserId: userId,
      eventType: "admin_setting_changed",
      eventMessage: "Updated SignOS organization settings",
      eventPayload: { ...input },
    });
    return updated;
  }
}
