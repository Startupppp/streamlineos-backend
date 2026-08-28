import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from "@nestjs/common";
import { and, eq, isNull, lte, inArray, desc } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  hrWorkflowDefinitions,
  hrWorkflowSteps,
  hrWorkflowInstances,
  hrWorkflowStepActions,
  hrWorkflowInstanceAttachments,
  hrWorkflowDelegations,
  type hrWorkflowObjectTypeEnum,
} from "../../../db/schema/hr/workflow-engine";
import { users, organizationMembers } from "../../../db/schema/common/auth";
import { orgUnits } from "../../../db/schema/common/organization";
import { hrEmployments, hrPeople } from "../../../db/schema";
import { AccessService } from "../../access/access.service";
import { EmploymentFactsService } from "../../directory/employment-facts.service";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";

type HrWorkflowObjectType = typeof hrWorkflowObjectTypeEnum.enumValues[number];

interface ResolvedStep {
  stepOrder: number;
  name: string;
  approverType: string;
  approverValue?: string | null;
  mode: string;
  slaHours?: number | null;
  escalationApproverType?: string | null;
  escalationApproverValue?: string | null;
  condition?: { field: string; operator: string; value: unknown } | null;
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
  action: "approved" | "rejected" | "cancelled" | "reopened" | "commented";
  comment?: string;
  attachments?: { url: string; name: string }[];
}

@Injectable()
export class HrWorkflowEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
    private readonly employment: EmploymentFactsService,
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

    const steps = await this.loadSteps(definition.id, db);
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

      await this.recordAction(orgId, instanceId, currentStep?.stepOrder ?? instance.currentStepOrder, actorUserId, actorUserId, action, comment, attachments);
      return this.getInstanceOrThrow(orgId, instanceId);
    }

    if (action === "commented") {
      await this.recordAction(orgId, instanceId, currentStep?.stepOrder ?? instance.currentStepOrder, actorUserId, actorUserId, "commented", comment, attachments);
      return instance;
    }

    if (!currentStep) throw new BadRequestException("No active step found");

    const resolvedApprovers = await this.resolveApprovers(currentStep, instance.subjectEmployeeId, orgId);
    const effectiveActor = await this.resolveEffectiveActor(orgId, actorUserId, resolvedApprovers, currentStep.approverType, instance.objectType as HrWorkflowObjectType);

    if (!effectiveActor) throw new ForbiddenException("You are not an approver for this step");

    const [definitionRow] = await this.db.select({ settings: hrWorkflowDefinitions.settings })
      .from(hrWorkflowDefinitions)
      .where(eq(hrWorkflowDefinitions.id, instance.definitionId))
      .limit(1);
    const settings = definitionRow?.settings as { rejectionCommentRequired?: boolean } | undefined;

    if (action === "rejected" && settings?.rejectionCommentRequired && !comment?.trim()) {
      throw new BadRequestException("Rejection comment is required");
    }

    await this.recordAction(orgId, instanceId, currentStep.stepOrder, resolvedApprovers[0] ?? actorUserId, actorUserId, action, comment, attachments);

    if (action === "rejected") {
      await this.db.update(hrWorkflowInstances)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(and(eq(hrWorkflowInstances.id, instanceId), eq(hrWorkflowInstances.orgId, orgId)));
      return this.getInstanceOrThrow(orgId, instanceId);
    }

    if (action === "approved") {
      return this.advanceInstance(instance, steps, orgId);
    }

    return this.getInstanceOrThrow(orgId, instanceId);
  }

  private async advanceInstance(instance: typeof hrWorkflowInstances.$inferSelect, steps: ResolvedStep[], orgId: string) {
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
      const resolvedApprovers = await this.resolveApprovers(currentStep, instance.subjectEmployeeId, orgId);

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

  async resolveApprovers(step: ResolvedStep, subjectEmployeeId: string, orgId: string): Promise<string[]> {
    switch (step.approverType) {
      case "named_user":
        return step.approverValue ? [step.approverValue] : [];

      case "direct_manager": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        return facts.managerUserId ? [facts.managerUserId] : [];
      }

      case "managers_manager": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        if (!facts.managerUserId) return [];
        const managerFacts = await this.employment.getFacts(orgId, facts.managerUserId);
        return managerFacts.managerUserId ? [managerFacts.managerUserId] : [];
      }

      case "department_head": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        if (!facts.departmentId) return [];
        const [dept] = await this.db.select({ headUserId: orgUnits.headUserId })
          .from(orgUnits).where(eq(orgUnits.id, facts.departmentId)).limit(1);
        return dept?.headUserId ? [dept.headUserId] : [];
      }

      case "hr_role": {
        const hrApprovers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
        return hrApprovers.map((m) => m.userId);
      }

      case "finance_role": {
        const financeApprovers = await this.access.membersWithPermission(orgId, "accounting:approvals:decide");
        return financeApprovers.map((m) => m.userId);
      }

      case "location_hr": {
        const facts = await this.employment.getFacts(orgId, subjectEmployeeId);
        if (!facts.locationId) return [];
        const hrApprovers = await this.access.membersWithPermission(orgId, "hr:leaves:approve");
        if (hrApprovers.length === 0) return [];
        const branchHr = await this.db
          .select({ id: users.id })
          .from(users)
          .innerJoin(hrPeople, livePersonOfUser(orgId, users.id))
          .innerJoin(hrEmployments, primaryEmploymentOfPerson(orgId))
          .where(and(
            inArray(users.id, hrApprovers.map((m) => m.userId)),
            eq(hrEmployments.locationId, facts.locationId),
          ))
          .limit(10);
        return branchHr.map((u) => u.id);
      }

      case "dynamic_expression": {
        if (!step.approverValue) return [];
        return this.resolveDynamicExpression(step.approverValue, subjectEmployeeId, orgId);
      }

      default:
        return [];
    }
  }

  private async resolveDynamicExpression(expression: string, subjectEmployeeId: string, orgId: string): Promise<string[]> {
    const [[member], facts] = await Promise.all([
      this.db.select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.userId, subjectEmployeeId), eq(organizationMembers.orgId, orgId)))
        .limit(1),
      this.employment.getFacts(orgId, subjectEmployeeId),
    ]);
    if (!member) return [];

    const employee: Record<string, unknown> = {
      id: subjectEmployeeId,
      reportingTo: facts.managerUserId,
      departmentId: facts.departmentId,
      branchId: facts.locationId,
      role: member.role,
    };

    const parts = expression.split(".");
    let value: unknown = employee;
    for (const part of parts.slice(1)) {
      if (value !== null && typeof value === "object" && part in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[part];
      } else {
        value = undefined;
        break;
      }
    }

    if (typeof value === "string" && value.length > 0) return [value];
    return [];
  }

  private async resolveEffectiveActor(
    orgId: string,
    actorUserId: string,
    resolvedApprovers: string[],
    _: string,
    objectType: HrWorkflowObjectType,
  ): Promise<string | null> {
    if (resolvedApprovers.includes(actorUserId)) return actorUserId;

    const now = new Date();
    const delegations = await this.db.select()
      .from(hrWorkflowDelegations)
      .where(
        and(
          eq(hrWorkflowDelegations.orgId, orgId),
          eq(hrWorkflowDelegations.delegateUserId, actorUserId),
          eq(hrWorkflowDelegations.active, true),
          lte(hrWorkflowDelegations.startsAt, now),
        ),
      )
      .limit(20);

    const validDelegations = delegations.filter((d) => {
      if (d.endsAt < now) return false;
      if (d.objectType !== null && d.objectType !== objectType) return false;
      return resolvedApprovers.includes(d.delegatorUserId);
    });

    return validDelegations.length > 0 ? actorUserId : null;
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

  private async recordAction(
    orgId: string,
    instanceId: number,
    stepOrder: number,
    approverUserId: string,
    actedByUserId: string,
    action: typeof hrWorkflowStepActions.$inferInsert["action"],
    comment?: string,
    attachments?: { url: string; name: string }[],
  ) {
    await this.db.transaction(async (tx) => {
      const [inserted] = await tx.insert(hrWorkflowStepActions).values({
        orgId,
        instanceId,
        stepOrder,
        approverUserId,
        actedByUserId,
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

  private async loadSteps(definitionId: number, db: Db) {
    return db.select().from(hrWorkflowSteps)
      .where(eq(hrWorkflowSteps.definitionId, definitionId))
      .orderBy(hrWorkflowSteps.stepOrder);
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
