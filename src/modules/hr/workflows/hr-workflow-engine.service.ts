import {
  Inject,
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { and, eq, isNull, inArray, desc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowDefinitions,
  hrWorkflowInstances,
  hrWorkflowStepActions,
} from "../../../db/schema/hr/workflow-engine";
import { HrWorkflowApproverService } from "./hr-workflow-approver.service";
import { HrWorkflowStepRunnerService } from "./hr-workflow-step-runner.service";
import type {
  HrWorkflowObjectType,
  ResolvedStep,
} from "./hr-workflow-engine.types";
import { organizationMembers } from "../../../db/schema/common/auth";
import { sweepOverdueWorkflowSteps } from "./hr-workflow-overdue-sweep";

function isResolvedStepArray(steps: unknown[]): steps is ResolvedStep[] {
  return steps.every(
    (s) =>
      typeof s === "object" &&
      s !== null &&
      "stepOrder" in s &&
      "name" in s &&
      "approverType" in s &&
      "mode" in s,
  );
}

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
  actorMembershipId?: number | null;
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

  async startWorkflow({
    orgId,
    objectType,
    objectId,
    requestedByUserId,
    subjectEmployeeId,
    context = {},
    tx,
  }: StartWorkflowParams) {
    const db = tx ?? this.db;
    const actorRows = await db
      .select({
        userId: organizationMembers.userId,
        membershipId: organizationMembers.id,
      })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          inArray(organizationMembers.userId, [
            requestedByUserId,
            subjectEmployeeId,
          ]),
        ),
      )
      .limit(2);
    const membershipIdByUserId = new Map(
      actorRows.map((row) => [row.userId, row.membershipId]),
    );
    const requestedByMembershipId =
      membershipIdByUserId.get(requestedByUserId) ?? null;
    const subjectEmployeeMembershipId =
      membershipIdByUserId.get(subjectEmployeeId) ?? null;

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
          definitionId: await this.getOrCreateSyntheticDefinitionId(
            orgId,
            objectType,
            db,
          ),
          definitionSnapshot: { steps: [] },
          objectType,
          objectId,
          requestedBy: requestedByUserId,
          requestedByMembershipId,
          subjectEmployeeId,
          subjectEmployeeMembershipId,
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
    const routed = firstStep
      ? await this.stepRunner.routingFor(firstStep, subjectEmployeeId, orgId, objectType, context)
      : { context, dueAt: null };

    const [instance] = await db
      .insert(hrWorkflowInstances)
      .values({
        orgId,
        definitionId: definition.id,
        definitionSnapshot: snapshot,
        objectType,
        objectId,
        requestedBy: requestedByUserId,
        requestedByMembershipId,
        subjectEmployeeId,
        subjectEmployeeMembershipId,
        context: routed.context,
        status: steps.length === 0 ? "approved" : "in_progress",
        currentStepOrder: steps.length === 0 ? 0 : (firstStep?.stepOrder ?? 1),
        dueAt: routed.dueAt ?? undefined,
      })
      .returning();

    return instance;
  }

  async act({
    orgId,
    instanceId,
    actorUserId,
    actorMembershipId,
    action,
    comment,
    attachments,
  }: ActParams) {
    const instance = await this.getInstanceOrThrow(orgId, instanceId);

    if (
      instance.status === "approved" ||
      instance.status === "rejected" ||
      instance.status === "cancelled"
    ) {
      throw new BadRequestException(`Instance is already ${instance.status}`);
    }

    const snapshotSteps = instance.definitionSnapshot.steps;
    if (!isResolvedStepArray(snapshotSteps)) {
      throw new BadRequestException("Workflow instance has a corrupted step snapshot");
    }
    const steps = snapshotSteps;
    const currentStep = steps.find(
      (s) => s.stepOrder === instance.currentStepOrder,
    );

    if (action === "cancelled" || action === "reopened") {
      const newStatus = action === "cancelled" ? "cancelled" : "reopened";
      await this.db
        .update(hrWorkflowInstances)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(
          and(
            eq(hrWorkflowInstances.id, instanceId),
            eq(hrWorkflowInstances.orgId, orgId),
          ),
        );

      await this.stepRunner.recordAction(
        orgId,
        instanceId,
        currentStep?.stepOrder ?? instance.currentStepOrder,
        actorUserId,
        actorUserId,
        action,
        comment,
        attachments,
        actorMembershipId,
        actorMembershipId,
      );
      return this.getInstanceOrThrow(orgId, instanceId);
    }

    if (action === "commented") {
      if (actorMembershipId == null)
        throw new ForbiddenException("Organization membership required");
      await this.stepRunner.recordAction(
        orgId,
        instanceId,
        currentStep?.stepOrder ?? instance.currentStepOrder,
        actorUserId,
        actorUserId,
        "commented",
        comment,
        attachments,
        actorMembershipId,
        actorMembershipId,
      );
      return instance;
    }

    if (!currentStep) throw new BadRequestException("No active step found");

    const resolvedApprovers = await this.stepRunner.currentApprovers(instance, currentStep, orgId);
    if (actorMembershipId == null) {
      throw new ForbiddenException("Organization membership required");
    }
    const effectiveActor = await this.approver.resolveEffectiveActor(
      orgId,
      actorMembershipId,
      resolvedApprovers,
      currentStep.approverType,
      instance.objectType,
    );

    if (!effectiveActor)
      throw new ForbiddenException("You are not an approver for this step");

    const [definitionRow] = await this.db
      .select({ settings: hrWorkflowDefinitions.settings })
      .from(hrWorkflowDefinitions)
      .where(eq(hrWorkflowDefinitions.id, instance.definitionId))
      .limit(1);
    const settings = definitionRow?.settings;

    if (
      action === "rejected" &&
      settings?.rejectionCommentRequired &&
      !comment?.trim()
    ) {
      throw new BadRequestException("Rejection comment is required");
    }

    const [approverMembership] =
      resolvedApprovers.length > 0
        ? await this.db
            .select({ membershipId: organizationMembers.id })
            .from(organizationMembers)
            .where(
              and(
                eq(organizationMembers.orgId, orgId),
                eq(organizationMembers.userId, resolvedApprovers[0]),
              ),
            )
            .limit(1)
        : [];
    await this.stepRunner.recordAction(
      orgId,
      instanceId,
      currentStep.stepOrder,
      resolvedApprovers[0] ?? actorUserId,
      actorUserId,
      action,
      comment,
      attachments,
      actorMembershipId,
      approverMembership?.membershipId ?? actorMembershipId,
    );

    if (action === "rejected") {
      await this.db
        .update(hrWorkflowInstances)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(
          and(
            eq(hrWorkflowInstances.id, instanceId),
            eq(hrWorkflowInstances.orgId, orgId),
          ),
        );
      return this.getInstanceOrThrow(orgId, instanceId);
    }

    if (action === "approved") {
      return this.stepRunner.advanceInstance(instance, steps, orgId);
    }

    return this.getInstanceOrThrow(orgId, instanceId);
  }

  async sweepOverdueSteps(orgId?: string) {
    return sweepOverdueWorkflowSteps(this.db, orgId);
  }

  private async getOrCreateSyntheticDefinitionId(
    orgId: string,
    objectType: HrWorkflowObjectType,
    db: Db,
  ): Promise<number> {
    const [upserted] = await db
      .insert(hrWorkflowDefinitions)
      .values({
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

    const [found] = await db
      .select({ id: hrWorkflowDefinitions.id })
      .from(hrWorkflowDefinitions)
      .where(
        and(
          eq(hrWorkflowDefinitions.orgId, orgId),
          eq(hrWorkflowDefinitions.objectType, objectType),
          eq(hrWorkflowDefinitions.name, "__auto_approve__"),
        ),
      )
      .limit(1);
    return found?.id ?? 0;
  }

  async getInstanceTimeline(orgId: string, instanceId: number) {
    const instance = await this.getInstanceOrThrow(orgId, instanceId);
    const actions = await this.db.query.hrWorkflowStepActions.findMany({
      limit: 100,
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
    const [instance] = await this.db
      .select()
      .from(hrWorkflowInstances)
      .where(
        and(
          eq(hrWorkflowInstances.id, instanceId),
          eq(hrWorkflowInstances.orgId, orgId),
        ),
      )
      .limit(1);

    if (!instance) throw new NotFoundException("Workflow instance not found");
    return instance;
  }
}
