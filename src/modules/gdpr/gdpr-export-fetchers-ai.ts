import { and, asc, eq, gt } from "drizzle-orm";
import {
  aiActionProposals,
  aiChatConversations,
  aiChatMessages,
  aiFeedback,
  aiJobs,
  aiUsageLogs,
} from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { BATCH_SIZE } from "./gdpr-export-types";

export async function fetchAiFeedback(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(aiFeedback.orgId, orgId),
    eq(aiFeedback.userId, subjectUserId),
  ];
  if (afterId !== undefined) conditions.push(gt(aiFeedback.id, afterId));
  return db
    .select({
      id: aiFeedback.id,
      feature: aiFeedback.feature,
      correlationId: aiFeedback.correlationId,
      entityType: aiFeedback.entityType,
      entityId: aiFeedback.entityId,
      rating: aiFeedback.rating,
      reason: aiFeedback.reason,
      metadata: aiFeedback.metadata,
      createdAt: aiFeedback.createdAt,
    })
    .from(aiFeedback)
    .where(and(...conditions))
    .orderBy(asc(aiFeedback.id))
    .limit(BATCH_SIZE);
}

export async function fetchAiActionProposals(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(aiActionProposals.orgId, orgId),
    eq(aiActionProposals.userId, subjectUserId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(aiActionProposals.id, afterId));
  return db
    .select({
      id: aiActionProposals.id,
      action: aiActionProposals.action,
      payload: aiActionProposals.payload,
      payloadHash: aiActionProposals.payloadHash,
      status: aiActionProposals.status,
      idempotencyKey: aiActionProposals.idempotencyKey,
      expiresAt: aiActionProposals.expiresAt,
      executedAt: aiActionProposals.executedAt,
      result: aiActionProposals.result,
      createdAt: aiActionProposals.createdAt,
      updatedAt: aiActionProposals.updatedAt,
    })
    .from(aiActionProposals)
    .where(and(...conditions))
    .orderBy(asc(aiActionProposals.id))
    .limit(BATCH_SIZE);
}

export async function fetchAiJobs(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(aiJobs.orgId, orgId),
    eq(aiJobs.userId, subjectUserId),
  ];
  if (afterId !== undefined) conditions.push(gt(aiJobs.id, afterId));
  return db
    .select({
      id: aiJobs.id,
      type: aiJobs.type,
      payload: aiJobs.payload,
      status: aiJobs.status,
      priority: aiJobs.priority,
      attempts: aiJobs.attempts,
      maxAttempts: aiJobs.maxAttempts,
      idempotencyKey: aiJobs.idempotencyKey,
      runAt: aiJobs.runAt,
      lastError: aiJobs.lastError,
      result: aiJobs.result,
      createdAt: aiJobs.createdAt,
      updatedAt: aiJobs.updatedAt,
    })
    .from(aiJobs)
    .where(and(...conditions))
    .orderBy(asc(aiJobs.id))
    .limit(BATCH_SIZE);
}

export async function fetchAiUsageLogs(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(aiUsageLogs.orgId, orgId),
    eq(aiUsageLogs.userId, subjectUserId),
  ];
  if (afterId !== undefined) conditions.push(gt(aiUsageLogs.id, afterId));
  return db
    .select({
      id: aiUsageLogs.id,
      feature: aiUsageLogs.feature,
      model: aiUsageLogs.model,
      promptTokens: aiUsageLogs.promptTokens,
      completionTokens: aiUsageLogs.completionTokens,
      totalTokens: aiUsageLogs.totalTokens,
      estimatedCostUsd: aiUsageLogs.estimatedCostUsd,
      creditsMilli: aiUsageLogs.creditsMilli,
      metadata: aiUsageLogs.metadata,
      latencyMs: aiUsageLogs.latencyMs,
      correlationId: aiUsageLogs.correlationId,
      outcome: aiUsageLogs.outcome,
      createdAt: aiUsageLogs.createdAt,
    })
    .from(aiUsageLogs)
    .where(and(...conditions))
    .orderBy(asc(aiUsageLogs.id))
    .limit(BATCH_SIZE);
}

export async function fetchAiChatConversations(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(aiChatConversations.orgId, orgId),
    eq(aiChatConversations.userId, subjectUserId),
  ];
  if (afterId !== undefined)
    conditions.push(gt(aiChatConversations.id, afterId));
  return db
    .select({
      id: aiChatConversations.id,
      orgId: aiChatConversations.orgId,
      title: aiChatConversations.title,
      createdAt: aiChatConversations.createdAt,
      updatedAt: aiChatConversations.updatedAt,
    })
    .from(aiChatConversations)
    .where(and(...conditions))
    .orderBy(asc(aiChatConversations.id))
    .limit(BATCH_SIZE);
}

export async function fetchAiChatMessages(
  db: Db,
  orgId: string,
  subjectUserId: string,
  afterId: number | undefined,
) {
  const conditions = [
    eq(aiChatMessages.orgId, orgId),
    eq(aiChatMessages.userId, subjectUserId),
  ];
  if (afterId !== undefined) conditions.push(gt(aiChatMessages.id, afterId));
  return db
    .select({
      id: aiChatMessages.id,
      orgId: aiChatMessages.orgId,
      conversationId: aiChatMessages.conversationId,
      role: aiChatMessages.role,
      content: aiChatMessages.content,
      createdAt: aiChatMessages.createdAt,
    })
    .from(aiChatMessages)
    .where(and(...conditions))
    .orderBy(asc(aiChatMessages.id))
    .limit(BATCH_SIZE);
}
