import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { terminations, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AutomationService } from "../../automation/automation.service";
import { HrAutomationEngineService } from "../automations/hr-automation-engine.service";
import { transitionTermination } from "./lifecycle-transition";
import type { TerminationReviewInput } from "./dto/hr-lifecycle.schemas";

@Injectable()
export class TerminationLifecycleService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly automation: AutomationService,
    private readonly hrAutomation: HrAutomationEngineService,
  ) {}

  async submit(orgId: string, actorUserId: string, terminationId: number) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "DRAFT" && existing.status !== "REJECTED") {
      throw new BadRequestException("Only draft or rejected terminations can be submitted.");
    }

    const previousStatus = existing.status;

    await transitionTermination(this.db, {
      organizationId: orgId,
      terminationId,
      currentStatus: existing.status,
      currentVersion: existing.rowVersion,
      changes: {
        status: "PENDING_FINAL",
        finalRemarks: null,
        finalReviewedBy: null,
        finalReviewedAt: null,
      },
    });

    await this.audit.logCritical({
      action: "TERMINATION_SUBMITTED",
      userId: actorUserId,
      orgId,
      targetId: String(terminationId),
      targetType: "termination",
      metadata: { from: previousStatus, to: "PENDING_FINAL", employeeId: existing.userId },
    });

    return { success: true };
  }

  async finalReview(orgId: string, actorUserId: string, terminationId: number, input: TerminationReviewInput) {
    const existing = await this.db.query.terminations.findFirst({
      where: and(eq(terminations.id, terminationId), eq(terminations.orgId, orgId)),
    });
    if (!existing) throw new NotFoundException("Termination not found.");
    if (existing.status !== "PENDING_FINAL") throw new BadRequestException("Termination is not pending FINAL review.");

    if (input.decision === "reject" && !input.remarks) {
      throw new BadRequestException("Remarks are required when rejecting.");
    }

    const newStatus = input.decision === "approve" ? "APPROVED" : "REJECTED";

    await transitionTermination(this.db, {
      organizationId: orgId,
      terminationId,
      currentStatus: existing.status,
      currentVersion: existing.rowVersion,
      changes: {
        status: newStatus,
        finalReviewedBy: actorUserId,
        finalReviewedAt: new Date(),
        finalRemarks: input.remarks || null,
      },
    });

    await this.audit.logCritical({
      action: newStatus === "APPROVED" ? "TERMINATION_APPROVED" : "TERMINATION_REJECTED",
      userId: actorUserId,
      orgId,
      targetId: String(terminationId),
      targetType: "termination",
      metadata: { employeeId: existing.userId, remarks: input.remarks },
    });

    return { success: true };
  }

  async invalidateHrDashboardCache(orgId: string): Promise<void> {
    await Promise.all([
      this.cache.invalidate(`hr:analytics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:metrics:${orgId}`),
      this.cache.invalidate(`hr:dashboard:headcount-trends:${orgId}`),
      this.cache.invalidate(`hr:celebrations:${orgId}`),
    ]);
  }

  dispatchEmployeeTerminated(
    orgId: string,
    terminationId: number,
    employeeId: string,
    reasons: string[],
    noticePeriodWaived: boolean,
  ): void {
    void (async () => {
      const employee = await this.db.query.users.findFirst({
        where: eq(users.id, employeeId),
        columns: { name: true },
      });
      const payload = {
        terminationId,
        userId: employeeId,
        employeeName: employee?.name ?? "Employee",
        effectiveDate: new Date().toISOString(),
        reasons,
        noticePeriodWaived,
        exitType: "termination",
      };
      await this.hrAutomation.emit(orgId, "exit.completed", {
        ...payload,
        exitType: "termination",
      });
      await this.automation.runAutomationsForEvent(orgId, "employee.terminated", payload);
    })().catch(() => undefined);
  }
}
