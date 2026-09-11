import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { deals, dealActivities, dealApprovals, dealStageTransitions } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { OutboxWriter } from "../../common/outbox/outbox-writer";
import { CacheService } from "../../common/cache/cache.service";
import { AuditService } from "../../common/audit/audit.service";
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
import { LifecycleService } from "../lifecycle/lifecycle.service";
import {
  announceDealUpdate,
  maybeCreateNegotiationChannel,
  resolveDefaultDealPipelineId,
  resolvePipelineStageMap,
  type DealRow,
  type DealUpdateEffectsDeps,
} from "./lib/deal-update-effects";
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
    private readonly lifecycle: LifecycleService,
  ) {}

  listDeals(orgId: string, userId: string, query: ListDealsInput, scope: DataScope) {
    return this.crud.listDeals(orgId, userId, query, scope);
  }

  createDeal(orgId: string, userId: string, input: CreateDealInput) {
    return this.crud.createDeal(orgId, userId, input);
  }

  getDeal(orgId: string, userId: string, dealId: number, scope: DataScope) {
    return this.crud.getDeal(orgId, userId, dealId, scope);
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

  cloneDeal(orgId: string, userId: string, dealId: number, scope: DataScope) {
    return this.crud.cloneDeal(orgId, userId, dealId, scope);
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

  /** Bound once so every extracted effect sees the same injected instances. */
  private get effectsDeps(): DealUpdateEffectsDeps {
    return {
      db: this.db,
      cache: this.cache,
      audit: this.audit,
      dispatch: this.dispatch,
      automation: this.automation,
      webhooksDispatch: this.webhooksDispatch,
      crmMetadata: this.crmMetadata,
      bus: this.bus,
    };
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

      const pipelineId = existing.pipelineId ?? await resolveDefaultDealPipelineId(this.effectsDeps, orgId);

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

      const stageMap = pipelineId ? await resolvePipelineStageMap(this.effectsDeps, orgId, pipelineId) : new Map<string, { stageType: string; isTerminal: boolean; probability: number }>();
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
          await maybeCreateNegotiationChannel(this.effectsDeps, orgId, userId, dealId);
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
        /**
         * A won deal opens a customer lifecycle. P5-07.
         *
         * Here rather than on the `deal.closed` outbox event, and that is a
         * deliberate choice against the tidier-looking one: the outbox registry
         * is keyed one consumer per event type, and `offer-fulfillment` already
         * holds `deal.closed`. Registering a second consumer for it would
         * silently replace the sales-order creation with this.
         *
         * Inside the transaction, like the stage ledger three lines above and
         * for the same reason: a renewal record that survives a rolled-back win
         * puts revenue in the book for a sale that never closed. The service
         * returns its refusals as values rather than throwing, so a deal with no
         * resolvable customer still closes.
         */
        await this.lifecycle.recordClosedWon(tx as Db, {
          organizationId: orgId,
          dealId,
          partyId: row.partyId,
          leadPartyId: row.leadPartyId,
          clientId: row.clientId,
          leadId: row.leadId,
          valueMinor: row.valueMinor,
          actualCloseDate: row.actualCloseDate,
          customData: row.customData,
        });

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

    await announceDealUpdate(this.effectsDeps, {
      orgId,
      userId,
      dealId,
      input,
      updated,
      stageChanged,
      previousStage,
    });

    return { ok: true, deal: updated, stageChanged, previousStage };
  }
}
