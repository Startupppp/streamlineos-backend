import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { candidateSources } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { maskSecretHint } from "../../../../common/security/secret-encryption.util";
import { AuditService } from "../../../../common/audit/audit.service";
import { ProviderCredentialsService } from "./provider-credentials.service";
import {
  INTEGRATION_CATALOG,
  integrationFor,
  statusOf,
  type IntegrationStatus,
} from "./integration-catalog";

/**
 * The integrations desk: what Recruitment OS can talk to, what it currently
 * can, and the credentials that decide which.
 *
 * Reading is deliberately a derivation over the catalog rather than a list of
 * rows. An organisation that has never connected anything still sees all
 * fourteen entries with the reason each one is unavailable — which is the
 * difference between a product that admits what it cannot do and one whose
 * settings screen is simply empty.
 */
@Injectable()
export class RecruitmentIntegrationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly credentials: ProviderCredentialsService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<IntegrationStatus[]> {
    const saved = await this.credentials.listForDisplay(orgId);
    const byPlatform = new Map(saved.map((row) => [row.platform, row]));
    return INTEGRATION_CATALOG.map((definition) =>
      statusOf(definition, byPlatform.get(definition.platform) ?? null),
    );
  }

  /**
   * Save or replace the credentials for one integration.
   *
   * A token is accepted even when no adapter can use it yet. Refusing would be
   * tidier and would also mean an organisation cannot get ready ahead of a
   * partnership landing — and `statusOf` still reports `not-implemented`, so
   * nothing about the saved key makes the product claim the capability.
   */
  async connect(
    orgId: string,
    userId: string,
    platform: string,
    input: { token?: string | null; isActive?: boolean; meta?: Record<string, unknown> },
  ): Promise<IntegrationStatus> {
    const definition = integrationFor(platform);
    if (!definition) throw new NotFoundException("Unknown integration.");

    const existing = await this.credentials.forPlatform(orgId, platform);
    const sealed =
      input.token === undefined
        ? undefined
        : ProviderCredentialsService.seal(input.token?.trim() || null);

    const meta = { ...(existing?.meta ?? {}), ...(input.meta ?? {}) };

    await this.db
      .insert(candidateSources)
      .values({
        orgId,
        platform,
        isActive: input.isActive ?? true,
        oauthToken: sealed ?? null,
        meta,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [candidateSources.orgId, candidateSources.platform],
        set: {
          isActive: input.isActive ?? existing?.isActive ?? true,
          ...(sealed === undefined ? {} : { oauthToken: sealed }),
          meta,
          updatedAt: sql`now()`,
        },
      });

    this.audit.log({
      action: "RECRUITMENT_INTEGRATION_CONNECTED",
      userId,
      orgId,
      targetId: platform,
      targetType: "recruitment_integration",
      /** Never the token. Whether one was set, and nothing that reconstructs it. */
      metadata: { platform, tokenChanged: sealed !== undefined, isActive: input.isActive ?? true },
    });

    const after = await this.credentials.forPlatform(orgId, platform);
    return statusOf(definition, {
      isActive: after?.isActive ?? false,
      hasCredentials: after?.token !== null && after?.token !== undefined,
      credentialHint: after?.token ? maskSecretHint(after.token) : null,
    });
  }

  async disconnect(orgId: string, userId: string, platform: string): Promise<{ platform: string }> {
    if (!integrationFor(platform)) throw new NotFoundException("Unknown integration.");
    await this.db
      .delete(candidateSources)
      .where(and(eq(candidateSources.orgId, orgId), eq(candidateSources.platform, platform)));
    this.audit.log({
      action: "RECRUITMENT_INTEGRATION_DISCONNECTED",
      userId,
      orgId,
      targetId: platform,
      targetType: "recruitment_integration",
    });
    return { platform };
  }

  /**
   * Mint the secret a board signs its inbound application callbacks with, and
   * return it exactly once.
   *
   * It is generated here rather than typed by a recruiter because a secret
   * somebody chose is a secret somebody can guess, and it is returned only from
   * this call — the settings screen afterwards shows a hint, never the value.
   * Rotating replaces it, which breaks deliveries signed with the old one; that
   * is the point of rotating.
   */
  async rotateInboundSecret(
    orgId: string,
    userId: string,
    platform: string,
  ): Promise<{ platform: string; inboundSecret: string; callbackPath: string }> {
    const definition = integrationFor(platform);
    if (!definition) throw new NotFoundException("Unknown integration.");

    const secret = randomBytes(32).toString("hex");
    await this.connect(orgId, userId, platform, { meta: { inboundSecret: secret } });

    this.audit.log({
      action: "RECRUITMENT_INTEGRATION_SECRET_ROTATED",
      userId,
      orgId,
      targetId: platform,
      targetType: "recruitment_integration",
    });

    return {
      platform,
      inboundSecret: secret,
      callbackPath: `/public/board-apply/{orgSlug}/${platform}`,
    };
  }
}
