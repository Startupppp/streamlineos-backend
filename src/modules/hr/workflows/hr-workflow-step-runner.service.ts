import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowInstances,
  hrWorkflowSteps,
  hrWorkflowStepActions,
  hrWorkflowInstanceAttachments,
} from "../../../db/schema/hr/workflow-engine";
import { HrWorkflowApproverService } from "./hr-workflow-approver.service";
import type { ResolvedStep } from "./hr-workflow-engine.types";

@Injectable()
export class HrWorkflowStepRunnerService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly approver: HrWorkflowApproverService,
  ) {}

  private async getInstanceOrThrow(orgId: string, instanceId: number) {
    const [instance] = await this.db.select()
      .from(hrWorkflowInstances)
      .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)))
      .limit(1);

    if (!instance) throw new NotFoundException("Workflow instance not found");
    return instance;
  }

  async advanceInstance(instance: typeof hrWorkflowInstances.$inferSelect, steps: ResolvedStep[], orgId: string) {
    const currentStep = steps.find((s) => s.stepOrder === instance.currentStepOrder);
    if (!currentStep) {
      await this.db.update(hrWorkflowInstances)
        .set({ status: "approved", updatedAt: new Date() })
        .where(and(eq(hrWorkflowInstances.id, instance.id), eq(hrWorkflowInstances.orgId, orgId)));
      return this.getInstanceOrThrow(orgId, instance.id);
    }

    if (currentStep.mode === "parallel_any") {
      const nextStep = this.findNextStep(steps, currentStep.stepOrder);
      return this.transitionToStep(instance.id, orgId, nextStep, steps);
    }

    if (currentStep.mode === "parallel_all") {
      const actionsForStep = await this.db.select().from(hrWorkflowStepActions)
        .where(and(
          eq(hrWorkflowStepActions.instanceId, instance.id),
          eq(hrWorkflowStepActions.stepOrder, currentStep.stepOrder),
          inArray(hrWorkflowStepActions.action, ["approved"]),
        ));

      const approvedCount = actionsForStep.length;
      const resolvedApprovers = await this.approver.resolveApprovers(currentStep, instance.subjectEmployeeId, orgId);

      if (approvedCount < resolvedApprovers.length) {
        return this.getInstanceOrThrow(orgId, instance.id);
      }
    }

    const nextStep = this.findNextStep(steps, currentStep.stepOrder);
    return this.transitionToStep(instance.id, orgId, nextStep, steps);
  }

  private findNextStep(steps: ResolvedStep[], currentOrder: number) {
    return steps.find((s) => s.stepOrder > currentOrder) ?? null;
  }

  private async transitionToStep(instanceId: number, orgId: string, nextStep: ResolvedStep | null, steps: ResolvedStep[]) {
    if (!nextStep) {
      await this.db.update(hrWorkflowInstances)
        .set({ status: "approved", updatedAt: new Date(), currentStepOrder: steps.at(-1)?.stepOrder ?? 0 })
        .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)));
    } else {
      const dueAt = nextStep.slaHours ? new Date(Date.now() + nextStep.slaHours * 3600_000) : null;
      await this.db.update(hrWorkflowInstances)
        .set({ currentStepOrder: nextStep.stepOrder, dueAt: dueAt ?? undefined, updatedAt: new Date() })
        .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)));
    }
    return this.getInstanceOrThrow(orgId, instanceId);
  }

  async recordAction(
    orgId: string,
    instanceId: number,
    stepOrder: number,
    approverUserId: string,
    actedByUserId: string,
    action: typeof hrWorkflowStepActions.$inferInsert["action"],
    comment?: string,
    attachments?: { url: string; name: string }[],
    actorMembershipId?: number | null,
    approverMembershipId?: number | null,
  ) {
    await this.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(hrWorkflowStepActions).values({
        orgId,
        instanceId,
        stepOrder,
        approverUserId,
        approverMembershipId: approverMembershipId ?? null,
        actedByUserId,
        actedByMembershipId: actorMembershipId ?? null,
        action,
        comment: comment ?? null,
      }).returning({ id: hrWorkflowStepActions.id });

      if (!inserted) throw new Error("Failed to record workflow action");

      if (attachments && attachments.length > 0) {
        await tx.insert(hrWorkflowInstanceAttachments).values(
          attachments.map((a) => ({ orgId, actionId: inserted.id, url: a.url, name: a.name })),
        );
      }
    });
  }

  async loadSteps(definitionId: number, db: Db) {
    return db.select().from(hrWorkflowSteps)
      .where(eq(hrWorkflowSteps.definitionId, definitionId))
      .orderBy(hrWorkflowSteps.stepOrder);
  }
}
