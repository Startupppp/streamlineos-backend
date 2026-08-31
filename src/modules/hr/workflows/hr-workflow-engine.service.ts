import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common";
import { and, eq, isNull, lte, inArray, desc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowDefinitions,
  hrWorkflowInstances,
  hrWorkflowStepActions,
} from "../../../db/schema/hr/workflow-engine";
import { HrWorkflowApproverService } from "./hr-workflow-approver.service";
import { HrWorkflowStepRunnerService } from "./hr-workflow-step-runner.service";
import type { HrWorkflowObjectType, ResolvedStep } from "./hr-workflow-engine.types";

interface StartWorkflowParams {
  orgId: string;
  objectType: HrWorkflowObjectType;
  objectId: string;
  requestedByUserId: string;
  subjectEmployeeId: string;
  context?: Record<string, unknown>;
  tx?: Db;
}

interface ActParams {
  orgId: string;
  instanceId: number;
  actorUserId: string;
  action: "approved" | "rejected" | "cancelled" | "reopened" | "commented";
  comment?: string;
  attachments?: { url: string; name: string }[];
}

@Injectable()
export class HrWorkflowEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly approver: HrWorkflowApproverService,
    private readonly stepRunner: HrWorkflowStepRunnerService,
  ) {}

  async startWorkflow({ orgId, objectType, objectId, requestedByUserId, subjectEmployeeId, context = {}, tx }: StartWorkflowParams) {
    const db = tx ?? this.db;

    const [definition] = await db
      .select()
      .from(hrWorkflowDefinitions)
      .where(
        and(
          eq(hrWorkflowDefinitions.orgId, orgId),
          eq(hrWorkflowDefinitions.objectType, objectType),
          eq(hrWorkflowDefinitions.status, "active"),
          eq(hrWorkflowDefinitions.isDefault, true),
          isNull(hrWorkflowDefinitions.deletedAt),
        ),
      )
      .limit(1);

    if (!definition) {
      const [synthetic] = await db
        .insert(hrWorkflowInstances)
        .values({
          orgId,
          definitionId: await this.getOrCreateSyntheticDefinitionId(orgId, objectType, db),
          definitionSnapshot: { steps: [] },
          objectType,
          objectId,
          requestedBy: requestedByUserId,
          subjectEmployeeId,
          context,
          status: "approved",
          currentStepOrder: 0,
        })
        .returning();
      return synthetic;
    }

    const steps = await this.stepRunner.loadSteps(definition.id, db);
    const snapshot = { steps };

    const firstStep = steps[0];
    const dueAt = firstStep?.slaHours
      ? new Date(Date.now() + firstStep.slaHours * 3600_000)
      : undefined;

    const [instance] = await db
      .insert(hrWorkflowInstances)
      .values({
        orgId,
        definitionId: definition.id,
        definitionSnapshot: snapshot,
        objectType,
        objectId,
        requestedBy: requestedByUserId,
        subjectEmployeeId,
        context,
        status: steps.length === 0 ? "approved" : "in_progress",
        currentStepOrder: steps.length === 0 ? 0 : (firstStep?.stepOrder ?? 1),
        dueAt,
      })
      .returning();

    return instance;
  }

  async act({ orgId, instanceId, actorUserId, action, comment, attachments }: ActParams) {
    const instance = await this.getInstanceOrThrow(orgId, instanceId);

    if (instance.status === "approved" || instance.status === "rejected" || instance.status === "cancelled") {
      throw new BadRequestException(`Instance is already ${instance.status}`);
    }

    const steps = (instance.definitionSnapshot as { steps: ResolvedStep[] }).steps;
    const currentStep = steps.find((s) => s.stepOrder === instance.currentStepOrder);

    if (action === "cancelled" || action === "reopened") {
      const newStatus = action === "cancelled" ? "cancelled" : "reopened";
      await this.db.update(hrWorkflowInstances)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)));

      await this.stepRunner.recordAction(orgId, instanceId, currentStep?.stepOrder ?? instance.currentStepOrder, actorUserId, actorUserId, action, comment, attachments);
      return this.getInstanceOrThrow(orgId, instanceId);
    }

    if (action === "commented") {
      await this.stepRunner.recordAction(orgId, instanceId, currentStep?.stepOrder ?? instance.currentStepOrder, actorUserId, actorUserId, "commented", comment, attachments);
      return instance;
    }

    if (!currentStep) throw new BadRequestException("No active step found");

    const resolvedApprovers = await this.approver.resolveApprovers(currentStep, instance.subjectEmployeeId, orgId);
    const effectiveActor = await this.approver.resolveEffectiveActor(orgId, actorUserId, resolvedApprovers, currentStep.approverType, instance.objectType as HrWorkflowObjectType);

    if (!effectiveActor) throw new ForbiddenException("You are not an approver for this step");

    const [definitionRow] = await this.db.select({ settings: hrWorkflowDefinitions.settings })
      .from(hrWorkflowDefinitions)
      .where(eq(hrWorkflowDefinitions.id, instance.definitionId))
      .limit(1);
    const settings = definitionRow?.settings as { rejectionCommentRequired?: boolean } | undefined;

    if (action === "rejected" && settings?.rejectionCommentRequired && !comment?.trim()) {
      throw new BadRequestException("Rejection comment is required");
    }

    await this.stepRunner.recordAction(orgId, instanceId, currentStep.stepOrder, resolvedApprovers[0] ?? actorUserId, actorUserId, action, comment, attachments);

    if (action === "rejected") {
      await this.db.update(hrWorkflowInstances)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)));
      return this.getInstanceOrThrow(orgId, instanceId);
    }

    if (action === "approved") {
      return this.stepRunner.advanceInstance(instance, steps, orgId);
    }

    return this.getInstanceOrThrow(orgId, instanceId);
  }

  async sweepOverdueSteps(orgId?: string) {
    const now = new Date();
    const whereClause = orgId
      ? and(
          eq(hrWorkflowInstances.orgId, orgId),
          eq(hrWorkflowInstances.status, "in_progress"),
          lte(hrWorkflowInstances.dueAt, now),
        )
      : and(
          eq(hrWorkflowInstances.status, "in_progress"),
          lte(hrWorkflowInstances.dueAt, now),
        );

    const overdueInstances = await this.db.select({
      id: hrWorkflowInstances.id,
      orgId: hrWorkflowInstances.orgId,
      currentStepOrder: hrWorkflowInstances.currentStepOrder,
      definitionSnapshot: hrWorkflowInstances.definitionSnapshot,
    })
      .from(hrWorkflowInstances)
      .where(whereClause)
      .limit(100);

    const actionValues: (typeof hrWorkflowStepActions.$inferInsert)[] = [];
    const escalatedIds: number[] = [];

    for (const instance of overdueInstances) {
      const steps = (instance.definitionSnapshot as { steps: ResolvedStep[] }).steps;
      const currentStep = steps.find((s) => s.stepOrder === instance.currentStepOrder);
      if (!currentStep?.escalationApproverType || !currentStep.escalationApproverValue) continue;

      actionValues.push({
        orgId: instance.orgId,
        instanceId: instance.id,
        stepOrder: instance.currentStepOrder,
        approverUserId: currentStep.escalationApproverValue,
        actedByUserId: currentStep.escalationApproverValue,
        action: "escalated",
        comment: "Auto-escalated due to SLA breach",
      });
      escalatedIds.push(instance.id);
    }

    if (actionValues.length > 0) {
      const updatedAt = new Date();
      await this.db.transaction(async (tx) => {
        await tx.insert(hrWorkflowStepActions).values(actionValues);
        await tx.update(hrWorkflowInstances)
          .set({ dueAt: undefined, updatedAt })
          .where(inArray(hrWorkflowInstances.id, escalatedIds));
      });
    }

    return { swept: overdueInstances.length };
  }

  private async getOrCreateSyntheticDefinitionId(orgId: string, objectType: HrWorkflowObjectType, db: Db): Promise<number> {
    const [upserted] = await db.insert(hrWorkflowDefinitions).values({
      orgId,
      objectType,
      name: "__auto_approve__",
      status: "active",
      version: 1,
      isDefault: false,
      settings: {},
    })
      .onConflictDoNothing()
      .returning({ id: hrWorkflowDefinitions.id });

    if (upserted) return upserted.id;

    const [found] = await db.select({ id: hrWorkflowDefinitions.id })
      .from(hrWorkflowDefinitions)
      .where(and(
        eq(hrWorkflowDefinitions.orgId, orgId),
        eq(hrWorkflowDefinitions.objectType, objectType),
        eq(hrWorkflowDefinitions.name, "__auto_approve__"),
      ))
      .limit(1);
    return found?.id ?? 0;
  }

  async getInstanceTimeline(orgId: string, instanceId: number) {
    const instance = await this.getInstanceOrThrow(orgId, instanceId);
    const actions = await this.db.query.hrWorkflowStepActions.findMany({
      where: and(
        eq(hrWorkflowStepActions.orgId, orgId),
        eq(hrWorkflowStepActions.instanceId, instanceId),
      ),
      with: { attachments: { columns: { id: true, url: true, name: true } } },
      orderBy: [desc(hrWorkflowStepActions.actedAt)],
    });

    return { instance, actions };
  }

  async getInstanceOrThrow(orgId: string, instanceId: number) {
    const [instance] = await this.db.select()
      .from(hrWorkflowInstances)
      .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)))
      .limit(1);

    if (!instance) throw new NotFoundException("Workflow instance not found");
    return instance;
  }
}
