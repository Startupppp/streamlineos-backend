import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull, isNotNull, lte } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { crmSequenceEnrollments, crmSequenceSteps, crmSequences, tasks, leads } from "../../../db/schema";
import { logger } from "../../../common/logger/logger.service";
import { AutomationEmailService } from "../../automation/automation-email.service";

interface FlushResult {
  processed: number;
  advanced: number;
  stopped: number;
}

@Injectable()
export class CrmSequencesRunnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: AutomationEmailService,
  ) {}

  private async evaluateStopOn(
    stopOn: Record<string, unknown>,
    enrollment: { orgId: string; entityType: string; entityId: string },
  ): Promise<{ stop: boolean; reason: string }> {
    if (stopOn["converted"] === true) {
      if (enrollment.entityType === "lead") {
        const [row] = await this.db
          .select({ convertedAt: leads.convertedAt })
          .from(leads)
          .where(and(
            eq(leads.orgId, enrollment.orgId),
            eq(leads.id, parseInt(enrollment.entityId, 10)),
            isNotNull(leads.convertedAt),
          ))
          .limit(1);
        if (row) return { stop: true, reason: "stopOn_converted" };
      } else {
        return { stop: false, reason: "stopOn_converted_unsupported_entity" };
      }
    }

    const unsupported = ["replied", "meeting_booked"] as const;
    for (const key of unsupported) {
      if (stopOn[key] === true) {
        logger.warn("crm-sequences-runner: stopOn key not supported", { key });
      }
    }

    return { stop: false, reason: "" };
  }

  async flushDueEnrollments(now = new Date()): Promise<FlushResult> {
    const enrollments = await this.db
      .select({
        id: crmSequenceEnrollments.id,
        orgId: crmSequenceEnrollments.orgId,
        sequenceId: crmSequenceEnrollments.sequenceId,
        entityType: crmSequenceEnrollments.entityType,
        entityId: crmSequenceEnrollments.entityId,
        currentStep: crmSequenceEnrollments.currentStep,
        status: crmSequenceEnrollments.status,
        stopReason: crmSequenceEnrollments.stopReason,
      })
      .from(crmSequenceEnrollments)
      .where(
        and(
          eq(crmSequenceEnrollments.status, "active"),
          lte(crmSequenceEnrollments.nextRunAt, now),
          isNull(crmSequenceEnrollments.stopReason),
        ),
      )
      .limit(200);

    if (enrollments.length === 0) return { processed: 0, advanced: 0, stopped: 0 };

    const seqRows = await this.db
      .select({ id: crmSequences.id, stopOn: crmSequences.stopOn })
      .from(crmSequences)
      .where(isNull(crmSequences.deletedAt));
    const seqStopOnMap = new Map(seqRows.map((s) => [s.id, s.stopOn]));

    let advanced = 0;
    let stopped = 0;

    for (const enrollment of enrollments) {
      try {
        const rawStopOn = seqStopOnMap.get(enrollment.sequenceId);
        if (rawStopOn && typeof rawStopOn === "object") {
          const { stop, reason } = await this.evaluateStopOn(rawStopOn as Record<string, unknown>, enrollment);
          if (stop) {
            await this.db.update(crmSequenceEnrollments)
              .set({ status: "stopped", stopReason: reason, updatedAt: new Date() })
              .where(eq(crmSequenceEnrollments.id, enrollment.id));
            stopped++;
            continue;
          }
        }

        const steps = await this.db
          .select()
          .from(crmSequenceSteps)
          .where(eq(crmSequenceSteps.sequenceId, enrollment.sequenceId))
          .orderBy(crmSequenceSteps.sortOrder);

        const step = steps[enrollment.currentStep];

        if (!step) {
          await this.db
            .update(crmSequenceEnrollments)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(crmSequenceEnrollments.id, enrollment.id));
          stopped++;
          continue;
        }

        await this.executeStep(enrollment.orgId, step, enrollment.entityType, enrollment.entityId);

        const isLastStep = enrollment.currentStep >= steps.length - 1;

        if (isLastStep) {
          await this.db
            .update(crmSequenceEnrollments)
            .set({ status: "completed", updatedAt: new Date() })
            .where(eq(crmSequenceEnrollments.id, enrollment.id));
          stopped++;
        } else {
          const nextStep = steps[enrollment.currentStep + 1];
          const waitMs = (nextStep?.waitHours ?? 0) * 60 * 60 * 1000;
          const nextRunAt = new Date(now.getTime() + waitMs);
          await this.db
            .update(crmSequenceEnrollments)
            .set({ currentStep: enrollment.currentStep + 1, nextRunAt, updatedAt: new Date() })
            .where(eq(crmSequenceEnrollments.id, enrollment.id));
          advanced++;
        }
      } catch (err) {
        logger.error("crm-sequences-runner: enrollment step failed", {
          enrollmentId: enrollment.id,
          error: err,
        });
        await this.db
          .update(crmSequenceEnrollments)
          .set({ status: "failed", stopReason: err instanceof Error ? err.message : "step_error", updatedAt: new Date() })
          .where(eq(crmSequenceEnrollments.id, enrollment.id))
          .catch(() => {});
        stopped++;
      }
    }

    return { processed: enrollments.length, advanced, stopped };
  }

  private async executeStep(
    orgId: string,
    step: typeof crmSequenceSteps.$inferSelect,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const cfg = step.config ?? {};
    switch (step.stepType) {
      case "email": {
        await this.email.send({
          to: String(cfg["to"] ?? ""),
          subject: String(cfg["subject"] ?? ""),
          html: String(cfg["body"] ?? ""),
        });
        return;
      }
      case "call_task": {
        const dueInDays = typeof cfg["dueInDays"] === "number" ? cfg["dueInDays"] : 1;
        await this.db.insert(tasks).values({
          orgId,
          title: String(cfg["taskTitle"] ?? "Follow-up call"),
          entityType: entityType.toUpperCase() as "LEAD" | "DEAL" | "CONTACT",
          entityId: parseInt(entityId, 10),
          type: "CALL",
          assigneeId: typeof cfg["assigneeId"] === "string" ? cfg["assigneeId"] : null,
          dueDate: new Date(Date.now() + dueInDays * 86400000),
        });
        return;
      }
      case "whatsapp_task": {
        await this.db.insert(tasks).values({
          orgId,
          title: String(cfg["taskTitle"] ?? "WhatsApp follow-up"),
          entityType: entityType.toUpperCase() as "LEAD" | "DEAL" | "CONTACT",
          entityId: parseInt(entityId, 10),
          type: "WHATSAPP",
          assigneeId: typeof cfg["assigneeId"] === "string" ? cfg["assigneeId"] : null,
          dueDate: new Date(Date.now() + 86400000),
        });
        return;
      }
      case "wait":
        return;
      default:
        return;
    }
  }
}
