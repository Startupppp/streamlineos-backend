import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { logSideEffectFailure } from "../../common/logger/side-effect";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { deals, dealActivities, dealApprovals, dealStageTransitions, chatChannels, chatChannelMembers, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
import { CACHE_KEYS } from "../../common/cache/cache-keys";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";
import { AutomationService } from "../automation/automation.service";
import { WebhooksDispatchService } from "../webhooks/webhooks-dispatch.service";
import { CrmBlueprintsService } from "../crm/metadata/crm-blueprints.service";
import { CrmMetadataService } from "../crm/metadata/crm-metadata.service";
import { CrmValidationService } from "../crm/metadata/crm-validation.service";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { DealsCrudService } from "./deals-crud.service";
import { DealsActivitiesService } from "./deals-activities.service";
import { DealsImportExportService } from "./deals-import-export.service";
import {
  toMinorUnits,
  toTransitionRow,
  type StageActor,
  type StageTransitionRow,
} from "./deal-stage-ledger";
import type { DataScope } from "../access/access.types";
import type {
  BulkImportDealsInput,
  CreateDealInput,
  DealBulkDeleteInput,
  DealBulkUpdateInput,
  ListDealsInput,
  LogActivityInput,
  PatchCustomDataInput,
  UpdateDealInput,
} from "./dto/deals.schemas";

type DealRow = typeof deals.$inferSelect;

export type UpdateDealOutcome =
  | { ok: true; deal: DealRow; stageChanged: boolean; previousStage: string | null; approvalPending?: false; approvalId?: undefined }
  | { ok: true; deal: DealRow; stageChanged: false; previousStage: null; approvalPending: true; approvalId: number }
  | { ok: false; reason: "version_conflict" | "not_found" };

@Injectable()
export class DealsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly dispatch: NotificationDispatchService,
    private readonly automation: AutomationService,
    private readonly webhooksDispatch: WebhooksDispatchService,
    private readonly blueprints: CrmBlueprintsService,
    private readonly crmMetadata: CrmMetadataService,
    private readonly crmValidation: CrmValidationService,
    private readonly bus: CrmAutomationBusService,
    private readonly crud: DealsCrudService,
    private readonly activities: DealsActivitiesService,
    private readonly importExport: DealsImportExportService,
  ) {}

  listDeals(orgId: string, userId: string, query: ListDealsInput, scope: DataScope) {
    return this.crud.listDeals(orgId, userId, query, scope);
  }

  createDeal(orgId: string, userId: string, input: CreateDealInput) {
    return this.crud.createDeal(orgId, userId, input);
  }

  getDeal(orgId: string, dealId: number) {
    return this.crud.getDeal(orgId, dealId);
  }

  deleteDeal(orgId: string, userId: string, dealId: number) {
    return this.crud.deleteDeal(orgId, userId, dealId);
  }

  bulkUpdate(orgId: string, userId: string, input: DealBulkUpdateInput) {
    return this.crud.bulkUpdate(orgId, userId, input);
  }

  bulkDelete(orgId: string, userId: string, input: DealBulkDeleteInput) {
    return this.crud.bulkDelete(orgId, userId, input);
  }

  cloneDeal(orgId: string, dealId: number) {
    return this.crud.cloneDeal(orgId, dealId);
  }

  listActivities(orgId: string, dealId: number) {
    return this.activities.listActivities(orgId, dealId);
  }

  listStageTransitions(orgId: string, dealId: number) {
    return this.activities.listStageTransitions(orgId, dealId);
  }

  addActivity(orgId: string, userId: string, dealId: number, input: LogActivityInput) {
    return this.activities.addActivity(orgId, userId, dealId, input);
  }

  updateCustomData(orgId: string, dealId: number, input: PatchCustomDataInput) {
    return this.activities.updateCustomData(orgId, dealId, input);
  }

  bulkImport(orgId: string, userId: string, input: BulkImportDealsInput) {
    return this.importExport.bulkImport(orgId, userId, input);
  }

  exportCsv(orgId: string) {
    return this.importExport.exportCsv(orgId);
  }

  private async resolvePipelineStageMap(orgId: string, pipelineId: string | null): Promise<Map<string, { stageType: string; isTerminal: boolean; probability: number }>> {
    const metadata = await this.crmMetadata.getAggregate(orgId);
    const stages = metadata.stages.filter((s: { pipelineId: string; isActive: boolean }) => {
      if (pipelineId) return s.pipelineId === pipelineId && s.isActive;
      const defaultPipeline = metadata.pipelines.find((p: { type: string | null; isDefault: boolean }) => p.type === "deal" && p.isDefault);
      return defaultPipeline ? s.pipelineId === defaultPipeline.id && s.isActive : false;
    });
    return new Map(stages.map((s: { key: string; stageType: string; isTerminal: boolean; probability: number }) => [s.key, { stageType: s.stageType, isTerminal: s.isTerminal, probability: s.probability }]));
  }

  private async resolveDefaultDealPipelineId(orgId: string): Promise<string | null> {
    const metadata = await this.crmMetadata.getAggregate(orgId);
    return metadata.pipelines.find((p: { type: string | null; isDefault: boolean }) => p.type === "deal" && p.isDefault)?.id ?? null;
  }

  private async maybeCreateNegotiationChannel(orgId: string, userId: string, dealId: number): Promise<void> {
    const alreadyLinked = await this.db.query.chatChannels.findFirst({
      where: and(
        eq(chatChannels.orgId, orgId),
        eq(chatChannels.entityType, "deal"),
        eq(chatChannels.entityId, String(dealId)),
      ),
      columns: { id: true },
    });
    if (alreadyLinked) return;

    const dealRow = await this.db.query.deals.findFirst({
      where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
      columns: { name: true, assignedToId: true },
    });

    const channelName = dealRow ? `Deal: ${dealRow.name}` : `Deal #${dealId}`;

    const [newChannel] = await this.db
      .insert(chatChannels)
      .values({
        orgId,
        name: channelName,
        type: "GROUP",
        description: `Auto-created deal channel for deal #${dealId}`,
        entityType: "deal",
        entityId: String(dealId),
      })
      .returning({ id: chatChannels.id });

    if (!newChannel) return;

    const memberUserIds = [userId];
    if (dealRow?.assignedToId && dealRow.assignedToId !== userId)
      memberUserIds.push(dealRow.assignedToId);

    const membershipRows = await this.db
      .select({ userId: organizationMembers.userId, id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, memberUserIds)));

    const membershipByUserId = new Map(membershipRows.map((m) => [m.userId, m.id]));

    const memberValues = memberUserIds
      .map((uid) => {
        const membershipId = membershipByUserId.get(uid);
        if (!membershipId) return null;
        return { orgId, channelId: newChannel.id, membershipId, role: uid === userId ? "ADMIN" : "MEMBER" };
      })
      .filter((v) => v !== null);

    if (memberValues.length > 0)
      await this.db.insert(chatChannelMembers).values(memberValues);
  }

  private async sendStageChangeNotification(
    actorId: string,
    deal: DealRow,
    previousStage: string,
    newStage: string,
  ): Promise<void> {
    if (!deal.assignedToId) return;
    await this.dispatch.emit({
      eventKey: "crm.deal.stage_changed",
      orgId: deal.orgId,
      actorUserId: actorId,
      notifySelf: true,
      targetUserIds: [deal.assignedToId],
      entityType: "deal",
      entityId: String(deal.id),
      title: `Deal stage changed: ${deal.name}`,
      message: `${deal.name} moved from ${previousStage} to ${newStage}.`,
      variables: { dealName: deal.name, previousStage, newStage, value: deal.value, actorUserId: actorId },
    });
  }

  async updateDeal(
    orgId: string,
    userId: string,
    dealId: number,
    input: UpdateDealInput,
    actor: StageActor = { kind: "human", userId },
  ): Promise<UpdateDealOutcome> {
    const updateData: Partial<typeof deals.$inferInsert> = { updatedAt: new Date() };
    let stageChanged = false;
    let previousStage: string | null = null;
    let wonStageDetected = false;
    let transitionRow: StageTransitionRow | null = null;

    if (input.stage !== undefined) {
      const existing = await this.db.query.deals.findFirst({
        where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
        columns: { stage: true, updatedAt: true, pipelineId: true, value: true, lostReason: true, expectedCloseDate: true, notes: true, assignedToId: true },
      });
      if (!existing) return { ok: false, reason: "not_found" };

      if (input.version && existing.updatedAt) {
        const clientVersion = new Date(input.version).getTime();
        const serverVersion = new Date(existing.updatedAt).getTime();
        if (clientVersion < serverVersion) return { ok: false, reason: "version_conflict" };
      }

      const pipelineId = existing.pipelineId ?? await this.resolveDefaultDealPipelineId(orgId);

      if (pipelineId && existing.stage !== input.stage) {
        const transitionCheck = await this.blueprints.assertTransitionAllowed(
          orgId, pipelineId, existing.stage, input.stage,
          { ...input, value: existing.value, lostReason: existing.lostReason, expectedCloseDate: existing.expectedCloseDate },
        );
        if (!transitionCheck.allowed) {
          throw new BadRequestException({
            message: "Stage transition blocked: missing required fields",
            missingFields: transitionCheck.missingFields,
          });
        }
        if (transitionCheck.requiresApproval) {
          const [approval] = await this.db.insert(dealApprovals).values({
            orgId, dealId, requestedBy: userId, requestedStage: input.stage, status: "pending",
          }).returning();
          this.audit.log({ action: "deal.approval_requested", userId, orgId, targetId: String(dealId), targetType: "deal", metadata: { requestedStage: input.stage } });
          const currentDeal = await this.db.query.deals.findFirst({
            where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
          });
          if (!currentDeal) return { ok: false, reason: "not_found" };
          return { ok: true as const, deal: currentDeal, stageChanged: false, previousStage: null, approvalPending: true, approvalId: approval!.id };
        }
      }

      const stageMap = pipelineId ? await this.resolvePipelineStageMap(orgId, pipelineId) : new Map<string, { stageType: string; isTerminal: boolean; probability: number }>();
      const stageInfo = stageMap.get(input.stage);

      if (stageInfo?.stageType === "won") {
        updateData.actualCloseDate = new Date().toISOString().split("T")[0];
        updateData.probability = 100;
        wonStageDetected = true;
      } else if (stageInfo?.stageType === "lost") {
        updateData.actualCloseDate = new Date().toISOString().split("T")[0];
        updateData.probability = 0;
      }

      if (existing.stage !== input.stage) {
        stageChanged = true;
        previousStage = existing.stage ?? null;

        transitionRow = toTransitionRow({
          organizationId: orgId,
          dealId,
          pipelineId: pipelineId ?? null,
          fromStage: previousStage,
          toStage: input.stage,
          actor,
          reason: input.stageChangeReason ?? null,
        });

        await this.db.insert(dealActivities).values({
          orgId, dealId, type: "stage_change", previousValue: existing.stage, newValue: input.stage,
          subject: `Stage changed from ${existing.stage} to ${input.stage}`, userId,
        });
        if (stageInfo && stageInfo.probability >= 75 && stageInfo.stageType === "open") {
          await this.maybeCreateNegotiationChannel(orgId, userId, dealId);
        }
      }
    }

    const updateValidationRecord: Record<string, unknown> = {
      name: input.name ?? null,
      value: input.value ?? null,
      stage: input.stage ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
    };
    const updateValidation = await this.crmValidation.evaluate(orgId, "deal", updateValidationRecord, {
      stageKey: input.stage ?? undefined,
      existingRecordId: String(dealId),
    });
    if (!updateValidation.valid) {
      throw new BadRequestException(updateValidation.errors.map((e) => e.message).join("; "));
    }

    if (input.name !== undefined) updateData.name = input.name;
    if (input.value !== undefined) updateData.valueMinor = toMinorUnits(input.value);
    if (input.stage !== undefined) updateData.stage = input.stage;
    if (input.probability !== undefined) updateData.probability = input.probability;
    if (input.contactPerson !== undefined) updateData.contactPerson = input.contactPerson;
    if (input.contactEmail !== undefined) updateData.contactEmail = input.contactEmail;
    if (input.contactPhone !== undefined) updateData.contactPhone = input.contactPhone;
    if (input.assignedToId !== undefined) updateData.assignedToId = input.assignedToId;
    if (input.expectedCloseDate !== undefined) updateData.expectedCloseDate = input.expectedCloseDate;
    if (input.actualCloseDate !== undefined) updateData.actualCloseDate = input.actualCloseDate;
    if (input.lostReason !== undefined) updateData.lostReason = input.lostReason;
    if (input.notes !== undefined) updateData.notes = input.notes;
    if (input.partyId !== undefined) updateData.partyId = input.partyId;
    if (input.subjectId !== undefined) updateData.subjectId = input.subjectId;

    const updated = await this.db.transaction(async (tx) => {
      const [row] = await (tx as Db)
        .update(deals)
        .set(updateData)
        .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)))
        .returning();
      if (!row) return undefined;

      if (transitionRow) await (tx as Db).insert(dealStageTransitions).values(transitionRow);

      if (wonStageDetected && stageChanged) {
        await OutboxWriter.emit(tx, {
          eventId: randomUUID(),
          organizationId: orgId,
          aggregateType: "deal",
          aggregateId: String(dealId),
          aggregateVersion: row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now(),
          eventType: "deal.closed",
          payload: {
            dealId,
            orgId,
            dealName: row.name,
            dealValue: row.value ?? "0",
            closedAt: row.actualCloseDate ?? new Date().toISOString().split("T")[0],
            actorUserId: userId,
          },
          occurredAt: new Date(),
        });
      }

      return row;
    });

    if (!updated) return { ok: false, reason: "not_found" };

    const invalidations: Array<Promise<void>> = [
      this.cache.invalidateNamespace(`deals:list:${orgId}`),
      this.cache.invalidate(CACHE_KEYS.salesDashboard(orgId)),
    ];
    if (stageChanged) {
      invalidations.push(this.cache.invalidateNamespace(CACHE_KEYS.salesKpisNamespace(orgId)));
    }
    await Promise.all(invalidations);

    this.audit.log({
      action: stageChanged ? "deal.stage_changed" : "deal.updated",
      userId,
      orgId,
      targetId: String(dealId),
      targetType: "deal",
      metadata: { changedFields: Object.keys(input), newStage: input.stage },
    });

    if (stageChanged && input.stage) {
      const stageMapFinal = await this.resolvePipelineStageMap(orgId, null);
      const newStageInfo = stageMapFinal.get(input.stage);
      if (newStageInfo?.stageType === "won") {
        this.webhooksDispatch.dispatch(orgId, "deal.won", { id: updated.id, name: updated.name, value: updated.value, assignedToId: updated.assignedToId });
      } else if (newStageInfo?.stageType === "lost") {
        this.webhooksDispatch.dispatch(orgId, "deal.lost", { id: updated.id, name: updated.name, value: updated.value, lostReason: updated.lostReason });
      }

      void this.bus.emit(orgId, "deal.stage_changed", { entityType: "deal", entityId: String(updated.id), data: { stage: updated.stage, previousStage: previousStage ?? undefined }, actorId: userId }).catch(logSideEffectFailure("deal.stage_changed bus emit", { orgId, dealId: updated.id }));
      if (newStageInfo?.stageType === "won") {
        void this.bus.emit(orgId, "deal.won", { entityType: "deal", entityId: String(updated.id), data: { value: updated.value }, actorId: userId }).catch(logSideEffectFailure("deal.won bus emit", { orgId, dealId: updated.id }));
      } else if (newStageInfo?.stageType === "lost") {
        void this.bus.emit(orgId, "deal.lost", { entityType: "deal", entityId: String(updated.id), data: { lostReason: updated.lostReason ?? undefined }, actorId: userId }).catch(logSideEffectFailure("deal.lost bus emit", { orgId, dealId: updated.id }));
      }
    }

    if (stageChanged && previousStage && input.stage) {
      const newStage = input.stage;
      void this.sendStageChangeNotification(userId, updated, previousStage, newStage).catch(logSideEffectFailure("deal stage-change email notification", { orgId, dealId: updated.id }));
      void this.automation
        .runAutomationsForEvent(orgId, "deal.stage_changed", {
          id: updated.id,
          name: updated.name,
          value: updated.value,
          stage: updated.stage,
          previousStage,
          assignedToId: updated.assignedToId,
        })
        .catch(logSideEffectFailure("deal.stage_changed automations", { orgId, dealId: updated.id }));
    }

    return { ok: true, deal: updated, stageChanged, previousStage };
  }
}
