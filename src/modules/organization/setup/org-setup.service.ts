import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import {
  users,
  organizations,
  magicLinkTokens,
} from "../../../db/schema";
import { addMinutes } from "date-fns";
import { type Db } from "../../../db/drizzle.module";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type SetupInput } from "./dto/org.schemas";
import { ownerProfileUpdate } from "./owner-profile-update";
import { OnboardingSessionService } from "../../hr/onboarding/flow/onboarding-session.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import {
  runInTenantTransaction,
} from "../../../common/tenant/run-in-tenant-transaction";
import type { TenantTx } from "../../../common/tenant/with-tenant";
import {
  DEFAULT_SKIP_MODULES,
  provisionOrgModules,
} from "../../../common/org/provision-org-modules";
import { provisionEmployeeSelfService } from "../../../common/org/provision-employee-self-service";
import { OrgSetupResolverService } from "./org-setup-resolver.service";
import {
  AccountOrganizationIndexService,
  type DirectoryActivationOutcome,
} from "../core/account-organization-index.service";
import { OutboxWakeSignal } from "../../../common/outbox/outbox-wake.signal";
import { logger } from "../../../common/logger/logger.service";
import { emitSetupCompleted, claimOnboardingStamp } from "./org-setup-internals";

export { DEFAULT_SKIP_MODULES, provisionOrgModules };

const SKIP_INDUSTRY = "IT Services";
const SKIP_COMPANY_SIZE = "1-10";

@Injectable()
export class OrgSetupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly sessions: OnboardingSessionService,
    private readonly resolver: OrgSetupResolverService,
    private readonly accountOrgIndex: AccountOrganizationIndexService,
    private readonly wakeSignal: OutboxWakeSignal,
  ) {}

  // Runs on replays too, and writes before invalidating so no concurrent read re-caches the old org.
  private async publishSetupResult(
    userId: string,
    orgId: string,
  ): Promise<DirectoryActivationOutcome> {
    const activation = await this.accountOrgIndex.activate(userId, orgId);
    await this.cache.invalidate(CACHE_KEYS.userSession(userId));
    if (activation.status !== "activated")
      logger.error("[org-setup] directory activation did not select the setup org", {
        userId,
        orgId,
        activation: activation.status,
        ...(activation.status === "failed" ? { reason: activation.reason } : {}),
      });
    return activation;
  }

  async completeSetup(u: CurrentUserContext, input: SetupInput) {
    const t0 = Date.now();
    const target = await this.resolver.resolveOrCreateOrg(u, input);
    const t1 = Date.now();
    const { orgId } = target;
    if (!target.isOwner) {
      await this.publishSetupResult(u.userId, orgId);
      return { success: true, orgId };
    }

    const autoLoginToken = randomBytes(32).toString("hex");
    const now = new Date();

    const claimed = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const stamped = await claimOnboardingStamp(tx, orgId, now, {
          industry: input.industry,
          companySize: input.companySize,
          ...(input.country ? { country: input.country } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.companyName ? { name: input.companyName } : {}),
        });
        if (!stamped) return false;

        await provisionOrgModules(tx, orgId, input.enabledModules, u.userId);
        await provisionEmployeeSelfService(tx, orgId);

        await tx
          .update(users)
          .set({
            lastActiveOrgId: orgId,
            // HRMS-E2E-025. The owner's own name lands here, beside the phone
            // this already wrote. ownerProfileUpdate omits a field that was not
            // sent rather than writing an empty one, so a name from an earlier
            // sign-in survives a later setup submission that left it out.
            ...ownerProfileUpdate(input),
          })
          .where(eq(users.id, u.userId));

        await tx.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: u.userId,
          tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
          expiresAt: addMinutes(now, 10),
        });

        await emitSetupCompleted(tx, now, {
          orgId,
          userId: u.userId,
          moduleKeys: input.enabledModules,
          sessionAction: "complete",
          sendWelcome: true,
          industry: input.industry,
          invitees: input.invitees ?? [],
        });
        return true;
      },
      { orgId },
    );

    const t2 = Date.now();
    const activation = await this.publishSetupResult(u.userId, orgId);
    if (claimed) this.wakeSignal.wake();
    const t3 = Date.now();

    logger.info("[org-setup] completeSetup", {
      targetResolutionMs: t1 - t0,
      setupTransactionMs: t2 - t1,
      postCommitPublishMs: t3 - t2,
      totalMs: t3 - t0,
      orgId,
      claimed,
      activation: activation.status,
    });

    if (!claimed || activation.status !== "activated")
      return { success: true, orgId };

    return { success: true, orgId, autoLoginToken };
  }

  async skipSetup(u: CurrentUserContext, reason?: string) {
    const t0 = Date.now();
    const target = await this.resolver.resolveOrCreateOrg(u, {});
    const t1 = Date.now();
    const { orgId } = target;

    if (!target.isOwner) {
      await runInTenantTransaction(
        this.db,
        () => this.sessions.skipSession(orgId, u.userId, "org_setup", reason),
        { orgId },
      );
      await this.publishSetupResult(u.userId, orgId);
      return { success: true, orgId };
    }

    const autoLoginToken = randomBytes(32).toString("hex");
    const now = new Date();

    const claimed = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const stamped = await claimOnboardingStamp(tx, orgId, now, {
          industry: SKIP_INDUSTRY,
          companySize: SKIP_COMPANY_SIZE,
        });
        if (!stamped) return false;

        await provisionOrgModules(tx, orgId, DEFAULT_SKIP_MODULES, u.userId);
        await provisionEmployeeSelfService(tx, orgId);

        await tx
          .update(users)
          .set({ lastActiveOrgId: orgId })
          .where(eq(users.id, u.userId));

        await tx.insert(magicLinkTokens).values({
          id: randomUUID(),
          userId: u.userId,
          tokenHash: createHash("sha256").update(autoLoginToken).digest("hex"),
          expiresAt: addMinutes(now, 10),
        });

        await emitSetupCompleted(tx, now, {
          orgId,
          userId: u.userId,
          moduleKeys: DEFAULT_SKIP_MODULES,
          sessionAction: "skip",
          skipReason: reason,
          sendWelcome: false,
          industry: SKIP_INDUSTRY,
          invitees: [],
        });
        return true;
      },
      { orgId },
    );

    const t2 = Date.now();
    const activation = await this.publishSetupResult(u.userId, orgId);
    if (claimed) this.wakeSignal.wake();
    const t3 = Date.now();

    logger.info("[org-setup] skipSetup", {
      targetResolutionMs: t1 - t0,
      setupTransactionMs: t2 - t1,
      postCommitPublishMs: t3 - t2,
      totalMs: t3 - t0,
      orgId,
      claimed,
      activation: activation.status,
    });

    if (!claimed) return { success: true, orgId };

    this.audit.log({
      action: "org.setup.skipped",
      userId: u.userId,
      orgId,
      targetId: orgId,
      targetType: "organization",
    });

    if (activation.status !== "activated") return { success: true, orgId };

    return { success: true, orgId, autoLoginToken };
  }
}
