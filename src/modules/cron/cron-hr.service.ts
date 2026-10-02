import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { addDays, format } from "date-fns";
import {
  certifications,
  onboardingTasks,
  users,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AutomationService } from "../automation/automation.service";
import { HrAutomationEngineService } from "../hr/automations/hr-automation-engine.service";
import { RetentionService } from "../hr/governance/retention/retention.service";
import { logger } from "../../common/logger/logger.service";
import { withMembershipMutations } from "../../common/org/membership-mutations";
import { forEachOrg } from "../../common/tenant";
import { CronHrDocumentsService } from "./cron-hr-documents.service";

@Injectable()
export class CronHrService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
    private readonly documents: CronHrDocumentsService,
    private readonly retention: RetentionService,
  ) {}

  async processCertificationExpiry(): Promise<{ fired: number }> {
    const now = new Date();
    const todayStr = format(now, "yyyy-MM-dd");
    const thirtyDaysStr = format(addDays(now, 30), "yyyy-MM-dd");

    let fired = 0;

    await forEachOrg(this.db, "certification-expiry", async (tx, orgId) => {
      const expiring = await tx
        .select({
          id: certifications.id,
          orgId: certifications.orgId,
          userId: certifications.userId,
          name: certifications.name,
          issuingOrganization: certifications.issuingOrganization,
          expiryDate: certifications.expiryDate,
        })
        .from(certifications)
        .where(
          and(
            eq(certifications.orgId, orgId),
            gte(certifications.expiryDate, todayStr),
            lte(certifications.expiryDate, thirtyDaysStr),
            eq(certifications.reminderSent, false),
          ),
        )
        .limit(500);

      if (expiring.length === 0) return;

      const userIds = [...new Set(expiring.map((c) => c.userId))];
      const employeeRows = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds));
      const nameMap = new Map(employeeRows.map((u) => [u.id, u.name ?? ""]));

      const remindedCertIds: number[] = [];
      for (const cert of expiring) {
        const expiryDateStr = cert.expiryDate ?? "";
        const daysUntilExpiry = expiryDateStr
          ? Math.ceil((new Date(expiryDateStr).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
          : 0;

        await this.automation.runAutomationsForEvent(cert.orgId, "certification.expiring", {
          certificationId: cert.id,
          userId: cert.userId,
          employeeName: nameMap.get(cert.userId) ?? "",
          certificationName: cert.name,
          issuingOrganization: cert.issuingOrganization ?? null,
          expiryDate: expiryDateStr,
          daysUntilExpiry,
        });

        remindedCertIds.push(cert.id);
        fired++;
      }

      if (remindedCertIds.length > 0)
        await tx
          .update(certifications)
          .set({ reminderSent: true })
          .where(
            and(
              eq(certifications.orgId, orgId),
              inArray(certifications.id, remindedCertIds),
            ),
          );
    });

    logger.info("Certification expiry check complete", { fired });
    return { fired };
  }

  async processOnboardingCompletionSweep(): Promise<{ fired: number }> {
    const now = new Date();
    let fired = 0;

    // The sweep stamps `organization_members.onboarding_completed_at`, which
    // `JwtAuthGuard` reads through its 1-second local membership cache. The write and
    // its local clear are one operation, owned by `MembershipMutations`; the
    // drain runs once the whole sweep resolves, outside any org transaction, so
    // `scheduleStandingChange` falls through to running it inline.
    await withMembershipMutations((membership) =>
      forEachOrg(this.db, "onboarding-completion", async (tx, orgId) => {
        const taskStats = await tx
          .select({
            userId: onboardingTasks.userId,
            orgId: onboardingTasks.orgId,
            total: sql<number>`COUNT(*)::int`,
            pending: sql<number>`SUM(CASE WHEN ${onboardingTasks.status} != 'COMPLETED' THEN 1 ELSE 0 END)::int`,
          })
          .from(onboardingTasks)
          .where(eq(onboardingTasks.orgId, orgId))
          .groupBy(onboardingTasks.userId, onboardingTasks.orgId);

        const fullyCompleted = taskStats.filter((s) => s.total > 0 && s.pending === 0);
        if (fullyCompleted.length === 0) return;

        const userIds = fullyCompleted.map((s) => s.userId);
        const employeeRows = await tx
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(and(inArray(users.id, userIds), isNull(users.onboardingCompletedAt)));

        if (employeeRows.length === 0) return;

        const statsByUserId = new Map(fullyCompleted.map((s) => [s.userId, s]));

        const onboardedUserIds: string[] = [];
        for (const employee of employeeRows) {
          const stats = statsByUserId.get(employee.id);
          if (!stats) continue;

          await this.automation.runAutomationsForEvent(stats.orgId, "onboarding.completed", {
            userId: employee.id,
            employeeName: employee.name ?? "",
            employeeEmail: employee.email ?? "",
            totalTasks: stats.total,
            completedAt: now.toISOString(),
          });

          await this.hrAutomation.emit(stats.orgId, "employee.onboarded", {
            userId: employee.id,
            employeeName: employee.name ?? "",
            employeeEmail: employee.email ?? "",
            totalTasks: stats.total,
            completedAt: now.toISOString(),
          });

          onboardedUserIds.push(employee.id);
          fired++;
        }

        if (onboardedUserIds.length > 0) {
          // Both stamps are one statement for the whole org, not one per person:
          // `taskStats` is already filtered to `orgId`, so every `stats.orgId`
          // in the loop above is this org. The membership half used to run
          // inside the loop, which is the N+1 `check:db-call-count` had marked
          // fixed while it was still there.
          await membership.markOnboardingCompleted(tx, {
            orgId,
            userIds: onboardedUserIds,
            completedAt: now,
          });
          await tx
            .update(users)
            .set({ onboardingCompletedAt: now })
            .where(inArray(users.id, onboardedUserIds));
        }
      }),
    );

    logger.info("Onboarding completion sweep done", { fired });
    return { fired };
  }

  async processDocumentExpiry(): Promise<{ fired: number }> {
    return this.documents.processDocumentExpiry();
  }

  async sweepRetentionDeleteRequests(): Promise<{ processed: number; skipped: number }> {
    let processed = 0;
    let skipped = 0;

    await forEachOrg(this.db, "retention-delete-sweep", async (_tx, orgId) => {
      const result = await this.retention.sweepStrandedDeleteRequests(orgId);
      processed += result.processed;
      skipped += result.skipped;
    });

    logger.info("[retention-delete-sweep] sweep complete", { processed, skipped });
    return { processed, skipped };
  }
}
