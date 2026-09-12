import { and, eq, inArray, isNull } from "drizzle-orm";
import { deals, chatChannels, chatChannelMembers, organizationMembers } from "../../../db/schema";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { assertOrganizationActor } from "../../../common/organization/organization-actor";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { AutomationService } from "../../automation/automation.service";
import { WebhooksDispatchService } from "../../webhooks/webhooks-dispatch.service";
import { CrmMetadataService } from "../../crm/metadata/crm-metadata.service";
import { CrmAutomationBusService } from "../../crm/automation-studio/crm-automation-bus.service";
import type { UpdateDealInput } from "../dto/deals.schemas";

/**
 * Everything an update to a deal does apart from writing the row.
 *
 * `DealsService` is a facade: twelve of its thirteen methods forward to
 * `deals-crud`, `deals-activities` or `deals-import-export` in a single line.
 * `updateDeal` is the one it implements itself, and the reason it is long is not
 * that patching a deal is complicated — it is that a stage move is an event that
 * six other systems want to hear about. Reading the optimistic-lock check and
 * the transaction meant reading past all six.
 *
 * So the seam is the row write. What stays behind is the contract: resolve the
 * fields, take the lock, write, return `UpdateDealOutcome`. What lives here is
 * every consequence — CRM metadata reads that say what a stage *means*, the chat
 * channel a deal in negotiation gets, the assignee's notification, and the
 * post-commit fan-out to cache, audit, webhooks, the automation bus and the
 * automation engine. None of it can change the outcome the caller sees; the
 * fan-out is deliberately fire-and-forget, and `announceDealUpdate` preserves
 * that, `logSideEffectFailure` handlers and all.
 *
 * A deps bag and free functions rather than a second `@Injectable`, the shape
 * `deal-bulk-ops.ts` already uses here: the DI graph and every caller are
 * unchanged.
 */
export interface DealUpdateEffectsDeps {
  readonly db: Db;
  readonly cache: CacheService;
  readonly audit: AuditService;
  readonly dispatch: NotificationDispatchService;
  readonly automation: AutomationService;
  readonly webhooksDispatch: WebhooksDispatchService;
  readonly crmMetadata: CrmMetadataService;
  readonly bus: CrmAutomationBusService;
}

/**
 * The row as the database returns it, declared here rather than in the service
 * so nothing in this file has to import back out of it — `check:cycles` counts
 * a type-only import as a real edge.
 */
export type DealRow = typeof deals.$inferSelect;

export async function resolvePipelineStageMap(deps: DealUpdateEffectsDeps, orgId: string, pipelineId: string | null): Promise<Map<string, { stageType: string; isTerminal: boolean; probability: number }>> {
  const metadata = await deps.crmMetadata.getAggregate(orgId);
  const stages = metadata.stages.filter((s: { pipelineId: string; isActive: boolean }) => {
    if (pipelineId) return s.pipelineId === pipelineId && s.isActive;
    const defaultPipeline = metadata.pipelines.find((p: { type: string | null; isDefault: boolean }) => p.type === "deal" && p.isDefault);
    return defaultPipeline ? s.pipelineId === defaultPipeline.id && s.isActive : false;
  });
  return new Map(stages.map((s: { key: string; stageType: string; isTerminal: boolean; probability: number }) => [s.key, { stageType: s.stageType, isTerminal: s.isTerminal, probability: s.probability }]));
}

export async function resolveDefaultDealPipelineId(deps: DealUpdateEffectsDeps, orgId: string): Promise<string | null> {
  const metadata = await deps.crmMetadata.getAggregate(orgId);
  return metadata.pipelines.find((p: { type: string | null; isDefault: boolean }) => p.type === "deal" && p.isDefault)?.id ?? null;
}

export async function maybeCreateNegotiationChannel(deps: DealUpdateEffectsDeps, orgId: string, userId: string, dealId: number): Promise<void> {
  const alreadyLinked = await deps.db.query.chatChannels.findFirst({
    where: and(
      eq(chatChannels.orgId, orgId),
      eq(chatChannels.entityType, "deal"),
      eq(chatChannels.entityId, String(dealId)),
    ),
    columns: { id: true },
  });
  if (alreadyLinked) return;

  const dealRow = await deps.db.query.deals.findFirst({
    where: and(eq(deals.id, dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)),
    columns: { name: true, assignedToId: true },
  });

  const channelName = dealRow ? `Deal: ${dealRow.name}` : `Deal #${dealId}`;

  const creator = await assertOrganizationActor(deps.db, orgId, {
    kind: "user",
    userId,
  });

  const [newChannel] = await deps.db
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

  const membershipRows = await deps.db
    .select({ userId: organizationMembers.userId, id: organizationMembers.id })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, memberUserIds)))
    .limit(memberUserIds.length);

  const membershipByUserId = new Map(membershipRows.map((m) => [m.userId, m.id]));

  const memberValues = memberUserIds
    .map((uid) => {
      const membershipId = membershipByUserId.get(uid);
      if (!membershipId) return null;
      return { orgId, channelId: newChannel.id, membershipId, role: uid === userId ? "ADMIN" : "MEMBER" };
    })
    .filter((v) => v !== null);

  if (memberValues.length > 0)
    await deps.db.insert(chatChannelMembers).values(memberValues);
}

async function sendStageChangeNotification(
  deps: DealUpdateEffectsDeps,
  actorId: string,
  deal: DealRow,
  previousStage: string,
  newStage: string,
): Promise<void> {
  if (!deal.assignedToId) return;
  await deps.dispatch.emit({
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

/**
 * Told after the commit, never before.
 *
 * The cache bust and the audit line are awaited because a stale list is a bug
 * the next request sees; everything below them is `void`-ed with a failure log,
 * because a webhook endpoint being down must not fail an update that already
 * happened. Note that the second `resolvePipelineStageMap` here passes a null
 * pipeline on purpose — it re-reads through the org default rather than the
 * deal's own pipeline, which is the behaviour that shipped.
 */
export async function announceDealUpdate(
  deps: DealUpdateEffectsDeps,
  args: {
    orgId: string;
    userId: string;
    dealId: number;
    input: UpdateDealInput;
    updated: DealRow;
    stageChanged: boolean;
    previousStage: string | null;
  },
): Promise<void> {
  const { orgId, userId, dealId, input, updated, stageChanged, previousStage } = args;

  const invalidations: Array<Promise<void>> = [
    deps.cache.invalidateNamespace(`deals:list:${orgId}`),
    deps.cache.invalidate(CACHE_KEYS.salesDashboard(orgId)),
  ];
  if (stageChanged) {
    invalidations.push(deps.cache.invalidateNamespace(CACHE_KEYS.salesKpisNamespace(orgId)));
  }
  await Promise.all(invalidations);

  deps.audit.log({
    action: stageChanged ? "deal.stage_changed" : "deal.updated",
    userId,
    orgId,
    targetId: String(dealId),
    targetType: "deal",
    metadata: { changedFields: Object.keys(input), newStage: input.stage },
  });

  if (stageChanged && input.stage) {
    const stageMapFinal = await resolvePipelineStageMap(deps, orgId, null);
    const newStageInfo = stageMapFinal.get(input.stage);
    if (newStageInfo?.stageType === "won") {
      deps.webhooksDispatch.dispatch(orgId, "deal.won", { id: updated.id, name: updated.name, value: updated.value, assignedToId: updated.assignedToId });
    } else if (newStageInfo?.stageType === "lost") {
      deps.webhooksDispatch.dispatch(orgId, "deal.lost", { id: updated.id, name: updated.name, value: updated.value, lostReason: updated.lostReason });
    }

    void deps.bus.emit(orgId, "deal.stage_changed", { entityType: "deal", entityId: String(updated.id), data: { stage: updated.stage, previousStage: previousStage ?? undefined }, actorId: userId }).catch(logSideEffectFailure("deal.stage_changed bus emit", { orgId, dealId: updated.id }));
    if (newStageInfo?.stageType === "won") {
      void deps.bus.emit(orgId, "deal.won", { entityType: "deal", entityId: String(updated.id), data: { value: updated.value }, actorId: userId }).catch(logSideEffectFailure("deal.won bus emit", { orgId, dealId: updated.id }));
    } else if (newStageInfo?.stageType === "lost") {
      void deps.bus.emit(orgId, "deal.lost", { entityType: "deal", entityId: String(updated.id), data: { lostReason: updated.lostReason ?? undefined }, actorId: userId }).catch(logSideEffectFailure("deal.lost bus emit", { orgId, dealId: updated.id }));
    }
  }

  if (stageChanged && previousStage && input.stage) {
    const newStage = input.stage;
    void sendStageChangeNotification(deps, userId, updated, previousStage, newStage).catch(logSideEffectFailure("deal stage-change email notification", { orgId, dealId: updated.id }));
    void deps.automation
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
}
